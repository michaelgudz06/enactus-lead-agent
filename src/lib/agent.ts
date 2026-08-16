import crypto from "crypto";
import { AgentEvent, ConnectionType, Lead, Mode } from "./types";
import {
  chatJSON,
  streamReasoner,
  pluck,
  extractJSON,
  salvageObjects,
  REASONER,
  STRUCTURER,
  STRUCTURER_PROVIDER,
} from "./llm";
import { exaSearch, dedupeByDomain, ExaResult } from "./exa";
import { placesSearch, hasPlacesKey } from "./places";
import {
  enrichDomains,
  disqualify,
  orgFacts,
  grounded,
  provinceFromRequest,
  hasApolloKey,
  ApolloOrg,
  DISQUALIFIER_LABEL,
  isMembershipName,
  nameMatchesDomain,
  companyKey,
} from "./apollo";
import { db, hasDatabaseUrl } from "./db";
import { MAX_COUNT, parsedCount, requestedCount } from "./count";
import { ENACTUS_ORG, ENACTUS_PROJECTS, ENACTUS_VENTURES } from "./enactus";

type Emit = (e: AgentEvent) => void;

interface Plan {
  needClarification: boolean;
  questions: string[];
  searchQueries: string[];
  criteria: string;
  altAngle: string;
  location: string;
  placesQueries?: string[];
}

const STOP = new Set(
  "the a an and or of for to in on at with from find me some list companies company business businesses that are who is looking want need new leads potential more".split(
    " "
  )
);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .sort()
    .join(" ");
}

function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(" ").filter(Boolean));
  const sb = new Set(b.split(" ").filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}


// Drop reasons, rendered for a human. Any reason without a label is skipped
// rather than printed: a new drop reason added without a sentence rendered as
// "3 undefined" in the shortfall message a volunteer reads.
function dropReasons(dropped: Record<string, number>): string[] {
  return Object.entries(dropped)
    .filter(([k]) => k in DISQUALIFIER_LABEL)
    .map(([k, n]) => `${n} ${DISQUALIFIER_LABEL[k as keyof typeof DISQUALIFIER_LABEL]}`);
}

// A candidate plus whatever Apollo could verify about it.
interface Candidate {
  result: ExaResult;
  domain: string;
  org: ApolloOrg | null;
}

function planPrompt(mode: Mode): string {
  if (mode === "sales") {
    return `You help a project manager find B2B sales leads (potential customers to sell their product/service to). Turn their request into effective web-search queries and a crisp ideal-customer description.`;
  }
  return `You help Enactus SFU, a student social-entrepreneurship club at Simon Fraser University (Burnaby / Vancouver, BC), find corporate sponsors offering monetary or in-kind support. Favour Lower Mainland businesses with a track record of backing students or community, and especially any with Simon Fraser University (SFU) or Enactus alumni ties. Turn the user's request into effective web-search queries and a crisp ideal-sponsor description.

Only look for real companies, businesses, or grant-making foundations that could give money or in-kind support. NEVER target other student clubs, university clubs or associations (at SFU or elsewhere), or organizations whose "sponsorship" is actually a paid membership, paid directory listing, or a fee the club would have to pay. Word the search queries to find businesses/sponsors, not clubs or memberships.`;
}

export async function runAgent(
  input: { prompt: string; mode: Mode; answers?: string; userName: string; skipClarify?: boolean },
  emit: Emit
): Promise<void> {
  const { prompt, mode, answers, userName } = input;
  const fullPrompt = answers ? `${prompt}\n\nAdditional context from user: ${answers}` : prompt;

  // How many leads to deliver. Decided here, in code, before anything else.
  const targetCount = requestedCount(fullPrompt);
  // What they actually typed. A run is one 60s function (see RUN_DEADLINE
  // below), so 25 is a real limit and not a preference -- but it has to be said
  // out loud, or asking for 50 and being handed 21 with no explanation reads as
  // the agent ignoring the request.
  const askedFor = parsedCount(fullPrompt);
  const overCap = askedFor !== null && askedFor > MAX_COUNT;
  const capNote = overCap
    ? ` (you asked for ${askedFor}; ${MAX_COUNT} is the most one run can do -- run it again to keep going)`
    : "";
  const capTail = overCap ? ` ${MAX_COUNT} is the most one run can do, so run it again to keep going.` : "";

  // Vercel Hobby kills the function at 60s (see maxDuration in the route).
  // Stop our own work at 52s so there is room to persist the leads and flush
  // the stream. Overrunning it loses the whole run.
  const RUN_DEADLINE = Date.now() + 52_000;
  // Do NOT tune this from a one-off measurement. The same structuring call has
  // been measured at 1.0s and at over 20s within the same hour, on the same
  // model and provider -- two separate sessions have now sized this budget from
  // a lucky reading and starved the stage that actually produces the leads.
  // The reserve is deliberately generous, and structuring streams so that
  // overrunning it costs a few leads rather than all of them.
  const STRUCTURE_RESERVE_MS = 20_000;
  // R1 is verbose and never returns early, so this cap trades reasoning depth
  // for headroom rather than risking the run.
  const R1_CAP_MS = 16_000;
  const t0 = Date.now();
  const mark = (label: string) => console.log(`[agent] ${label} @${Date.now() - t0}ms`);

  // ── 1. Understand + plan ────────────────────────────────────────────────
  emit({
    type: "status",
    step: "understand",
    message: `Understanding your request. Target: ${targetCount} lead${targetCount === 1 ? "" : "s"}${capNote}`,
  });
  // Wider ask needs more angles, or every query returns the same few pages.
  const queryCount = targetCount <= 6 ? 3 : targetCount <= 12 ? 4 : 5;
  let plan: Plan;
  try {
    plan = await chatJSON<Plan>(
      [
        { role: "system", content: `${planPrompt(mode)}\n\nRespond ONLY with JSON of shape: {"needClarification": boolean, "questions": string[], "searchQueries": string[], "criteria": string, "altAngle": string, "location": string, "placesQueries": string[]}. Provide ${queryCount} DISTINCT searchQueries that attack the request from different angles (industry, community-giving language, local-news coverage, grant/foundation wording) so they do not all return the same pages.${
              mode === "sales"
                ? ""
                : ` The target is organisations that GIVE money or goods. Do not write queries that surface charities, foundations seeking donations, non-profits, or community groups looking for sponsors -- those compete with Enactus for the same donor dollars rather than funding it. Words like "non-profit", "charity" and "fundraiser" in a query reliably return the wrong side of the transaction.`
            } placesQueries: up to 3 short local-business queries suited to a maps search (e.g. "coffee shops Burnaby", "print shops near SFU"), or [] if the request is not about local storefront businesses. ALWAYS populate searchQueries, criteria and location, even when needClarification is true -- the user can skip the questions and those fields are still used. Only set needClarification true (with up to 2 short questions) if the request is too vague to search well. altAngle is a different angle to try if this search was already done before.` },
        { role: "user", content: fullPrompt },
      ],
      { model: STRUCTURER, provider: STRUCTURER_PROVIDER, maxTokens: 800 }
    );
  } catch (e) {
    emit({ type: "error", message: `Planning failed: ${(e as Error).message}` });
    return;
  }

  if (plan.needClarification && !answers && !input.skipClarify && plan.questions?.length) {
    emit({ type: "clarify", questions: plan.questions.slice(0, 2) });
    return;
  }

  // ── 2. History check (lightweight, in DB) ───────────────────────────────
  const norm = normalize(fullPrompt);
  if (hasDatabaseUrl()) {
    try {
      const data = (await db()`
        select prompt, normalized, created_at from enactus_searches
        where mode = ${mode} order by created_at desc limit 40`) as {
        prompt: string;
        normalized: string | null;
      }[];
      let best = { score: 0, prompt: "" };
      for (const row of data ?? []) {
        const score = jaccard(norm, row.normalized || normalize(row.prompt));
        if (score > best.score) best = { score, prompt: row.prompt };
      }
      if (best.score >= 0.45) {
        emit({
          type: "similar",
          message: `Heads up: we ran a very similar search before ("${best.prompt}").`,
          suggestion: plan.altAngle || "Try a different city or industry angle to avoid re-surfacing the same leads.",
          pastPrompt: best.prompt,
        });
      }
    } catch {
      // non-fatal
    }
  }

  // ── 3. Discover ─────────────────────────────────────────────────────────
  // The funnel is sized from targetCount rather than fixed. Previously this was
  // 3 queries x 6 results capped at 6 candidates, so "give me 10 leads" could
  // not have succeeded no matter how the model was prompted. Roughly 3
  // candidates per requested lead survives dedupe, the noise filter and the
  // already-on-the-board filter with enough left to choose from.
  // The planner returns needClarification with an EMPTY searchQueries array for
  // requests it considers vague ("give me 10 leads from Burnaby" hits this every
  // time). When the user has skipped the questions there is nothing to fall back
  // on, and the run used to die with a misleading "No candidates found". Asking
  // the planner nicely is not enough on its own, so synthesise queries here too.
  let queries = (plan.searchQueries ?? []).filter((q) => typeof q === "string" && q.trim()).slice(0, queryCount);
  if (!queries.length) {
    const subject = fullPrompt.replace(/\b\d{1,3}\b/g, " ").replace(/\s+/g, " ").trim();
    queries =
      mode === "sales"
        ? [subject, `${subject} companies`, `${subject} buyers`]
        : [
            `${subject} companies community sponsorship`,
            `${subject} businesses supporting local students`,
            `${subject} corporate giving community investment`,
          ];
    queries = queries.slice(0, queryCount);
  }
  const candidateTarget = Math.min(60, Math.max(12, targetCount * 3));
  // Dividing the target across queries assumed the queries return disjoint
  // results. They do not -- they are deliberately overlapping phrasings of one
  // subject, so dedupeByDomain collapses most of the union (18 raw -> 6 in one
  // observed failing run). At targetCount=5 the old arithmetic asked for 15 raw
  // URLs, fewer than the 18 the build before it used, so the count rebuild made
  // small asks WORSE at discovery while fixing them at structuring. Overshoot
  // instead: the searches already run in one Promise.all, so a wider net costs
  // one search's wall clock and the pool is sliced back before any LLM sees it.
  const perQuery = Math.min(25, Math.max(10, Math.ceil((candidateTarget * 2) / Math.max(1, queries.length))));

  const usingPlaces = hasPlacesKey() && (plan.placesQueries?.length ?? 0) > 0;
  emit({
    type: "status",
    step: "discover",
    message: `Searching ${usingPlaces ? "Exa + Google Places" : "the web with Exa"}: ${queries.join("  ·  ")}`,
  });

  // ── 2b. What is already on the board ────────────────────────────────────
  // Read BEFORE discovery, not after. This used to run only as a post-filter,
  // which meant every search spent its whole result budget re-finding companies
  // the club already had and then threw them away: measured at a 206-lead
  // board, 9 of 14 usable candidates were deleted here, leaving 4 to fill an
  // ask for 10. The filter below still runs -- it is the net for leads whose
  // website is null and so cannot be excluded by domain -- but the domains now
  // go to Exa first so it returns ground we have not covered.
  const boardDomains = new Set<string>();
  const boardNames = new Set<string>();
  if (hasDatabaseUrl()) {
    try {
      const rows = (await db()`
        select website, company from enactus_leads where mode = ${mode}`) as {
        website: string | null;
        company: string | null;
      }[];
      for (const r of rows ?? []) {
        if (r.website)
          boardDomains.add(domainOf(r.website.startsWith("http") ? r.website : `https://${r.website}`));
        if (r.company) boardNames.add(companyKey(r.company));
      }
      boardDomains.delete("");
    } catch {
      // Non-fatal: a dedupe we could not run must not stop the search.
    }
  }
  const excludeDomains = [...boardDomains];

  let found: ExaResult[] = [];
  try {
    const exaBatches = Promise.all(
      queries.map((q) => exaSearch(q, { numResults: perQuery, excludeDomains }).catch(() => []))
    );
    // Places returns actual businesses rather than pages about businesses, so
    // it is the better source for local storefront sponsors. Shaped into the
    // same ExaResult so everything downstream stays source-agnostic.
    const placeBatches = usingPlaces
      ? Promise.all(
          plan.placesQueries!.slice(0, 3).map((q) =>
            placesSearch(q, { maxResults: Math.ceil(candidateTarget / 2) }).then((ps) =>
              ps
                .filter((p) => p.website)
                .map<ExaResult>((p) => ({
                  url: p.website!,
                  title: p.name,
                  publishedDate: null,
                  author: null,
                  text: [p.name, p.primaryType?.replace(/_/g, " "), p.address]
                    .filter(Boolean)
                    .join(" · "),
                  highlights: [],
                }))
            )
          )
        )
      : Promise.resolve([] as ExaResult[][]);

    const [exa, places] = await Promise.all([exaBatches, placeBatches]);
    found = dedupeByDomain([...exa.flat(), ...places.flat()].filter((r) => r.url));
  } catch (e) {
    emit({ type: "error", message: `Discovery failed: ${(e as Error).message}` });
    return;
  }

  // Obvious non-company noise: encyclopedias, forums and job boards are never
  // the sponsor themselves.
  found = found.filter(
    (r) => !/wikipedia\.org|reddit\.com|indeed\.com|glassdoor\.|linkedin\.com|facebook\.com|yelp\./.test(r.url)
  );
  const foundCount = found.length;
  mark(`discovery done (${foundCount} raw)`);

  // ── 3a. Drop anything already on the board ──────────────────────────────
  // A rotating volunteer team runs this every few weeks. Without this filter
  // the same café resurfaces every search and two people email it a month
  // apart, which is the one failure that actually costs the club a sponsor.
  // Uses the sets read at 2b -- one query per run, not two. Exa has already
  // been told to avoid these domains, so this is now a backstop for the leads
  // it could not be told about (64 of 206 board rows have no website) and for
  // Google Places results, which never saw the exclusion list.
  let alreadyKnown = 0;
  {
    const before = found.length;
    found = found.filter((r) => {
      const d = domainOf(r.url);
      const n = (r.title ?? "").trim().toLowerCase();
      return !(boardDomains.has(d) || (n && boardNames.has(n)));
    });
    alreadyKnown = before - found.length;
  }

  // ── 3b. Verify against Apollo ───────────────────────────────────────────
  // Deterministic reality check: Apollo confirms a candidate is a real,
  // currently-staffed company in the right province in ~0.4s per 10 domains.
  // This is what removes defunct companies, national chains with no local
  // decision maker, and trade associations -- classes the prompt rules alone
  // never reliably caught.
  const province = provinceFromRequest(fullPrompt, plan.location, plan.criteria);
  let candidates: Candidate[] = found.map((r) => ({ result: r, domain: domainOf(r.url), org: null }));
  const dropped: Record<string, number> = {};
  if (hasApolloKey() && candidates.length) {
    const enriched = await enrichDomains(
      candidates.map((c) => c.domain).filter(Boolean),
      { signal: AbortSignal.timeout(Math.max(2000, Math.min(8000, RUN_DEADLINE - Date.now() - 20_000))) }
    );
    for (const c of candidates) c.org = enriched.get(c.domain) ?? null;
    mark(`apollo done`);
  }
  // Outside the Apollo block on purpose: the membership-name test needs no
  // enrichment, so a missing or rate-limited APOLLO_API_KEY must not silently
  // switch the whole guard off.
  candidates = candidates.filter((c) => {
    const why = disqualify(c.org, { province, name: c.result.title });
    if (why) dropped[why] = (dropped[why] ?? 0) + 1;
    return !why;
  });

  // Interleave verified and unverified rather than sorting verified first.
  // Sorting then slicing would quietly undo the whole point of disqualify()
  // never dropping on missing data: Apollo has poor coverage of very small
  // local businesses, so a verified-first sort pushes exactly the corner-shop
  // in-kind sponsors this club relies on below the cut whenever the pool is
  // large.
  const verified = candidates.filter((c) => c.org);
  const unverified = candidates.filter((c) => !c.org);
  const mixed: Candidate[] = [];
  for (let i = 0; i < Math.max(verified.length, unverified.length); i++) {
    if (verified[i]) mixed.push(verified[i]);
    if (unverified[i]) mixed.push(unverified[i]);
  }
  // Give the model roughly twice what we need so it has genuine choice, without
  // paying to reason over candidates that can never make the cut.
  candidates = mixed.slice(0, Math.max(targetCount * 2, 12));

  if (!candidates.length) {
    const why = alreadyKnown
      ? `Everything found was already on the board (${alreadyKnown} skipped). Try a different angle or city.`
      : "No candidates found. Try rephrasing or broadening the request.";
    emit({ type: "status", step: "discover", message: why });
    emit({ type: "done", count: 0, searchId: null });
    return;
  }

  // Say what was filtered rather than silently narrowing: a run that quietly
  // drops half its candidates reads as "the agent is weak at finding people".
  const notes = [
    `${foundCount} found`,
    alreadyKnown ? `${alreadyKnown} already on the board` : "",
    ...dropReasons(dropped),
  ].filter(Boolean);
  emit({
    type: "status",
    step: "research",
    message: `${notes.join(", ")} → analyzing ${candidates.length} candidates for ${targetCount} leads`,
  });

  // ── 4. Reason + score with R1 (visible reasoning) ───────────────────────
  // Apollo's facts go in as a labelled line so the model states real employee
  // counts, industries and locations instead of inventing them. Anything it
  // could not verify simply has no VERIFIED line.
  // Numbered with the candidate's GLOBAL index so a chunked structuring pass can
  // render a subset without renumbering: source_index always points straight
  // back into candidates[].
  const renderContext = (list: Candidate[], startIdx: number) =>
    list
      .map((c, i) => {
        const r = c.result;
        const facts = orgFacts(c.org);
        return [
          `[${startIdx + i + 1}] ${c.org?.name || r.title || c.domain}`,
          `URL: ${r.url}`,
          facts,
          (r.text || r.highlights.join(" ") || "").slice(0, 700),
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
  const context = renderContext(candidates, 0);

  const scoreSystem =
    mode === "sales"
      ? `You are a sales-lead analyst. Assess each candidate organization as a potential CUSTOMER for the user's product.\n\n${ENACTUS_VENTURES}`
      : `You are a sponsorship-lead analyst for Enactus SFU. Assess each candidate organization as a potential SPONSOR. Detect any Simon Fraser University (SFU) or Enactus alumni connection, or past-sponsor / SFU-ecosystem tie, strictly from the provided text.\n\n${ENACTUS_ORG}\n\n${ENACTUS_PROJECTS}\n\nFor each strong sponsor, identify which specific Enactus SFU project best matches their industry or values, so outreach can pitch that project.\n\nHARD EXCLUSIONS — drop these candidates entirely (do not output them at all): other student clubs, university clubs, or student associations (at SFU or any school); anything that would require Enactus to PAY (paid memberships, paid directory or association listings, ticketed programs, fee-based accelerators); and charities, hospital or arts foundations, and community non-profits that RAISE money rather than give it — they are competing for the same donors, not funding Enactus. Enactus is asking companies to give, not to join, pay, or fundraise alongside. Only keep real companies, businesses, and foundations that actually MAKE grants.`;

  // Stage A — R1 reasons out loud (visible), no JSON. Capped so it stays snappy.
  const reasoningUser = `User request: ${fullPrompt}
Ideal lead: ${plan.criteria}

Candidates:
${context}

The team needs ${targetCount} ${mode === "sales" ? "customers" : "sponsors"} to contact from this list, so cover at least ${targetCount} of the candidates. Outreach is cheap and breadth beats precision here: a plausible sponsor worth an email is a yes, not just the perfect one. Only rule a candidate out if it is genuinely unsuitable.

Reason candidate by candidate: how would each be approached and why might they say yes? Weigh SFU/Enactus ties, local fit, how winnable the ask is${mode === "sales" ? "" : ", and which specific Enactus SFU project each best aligns with"}. Where a VERIFIED line is present, use those figures rather than estimating. Be concise and specific. Do NOT output JSON, just think it through.`;

  mark("plan+exa done");
  emit({ type: "status", step: "reason", message: "DeepSeek R1 reasoning about each candidate" });
  // A fixed per-stage cap on R1 alone is not enough: planning and Exa have
  // already spent an unknown amount of the 60s function limit, and structuring
  // still has to run after this. Both LLM stages share ONE deadline instead, so
  // whatever planning overran comes out of R1's slice rather than out of
  // structuring, which is the stage that actually produces the leads.
  const msLeft = () => RUN_DEADLINE - Date.now();
  const R1_BUDGET_MS = Math.max(5000, Math.min(R1_CAP_MS, msLeft() - STRUCTURE_RESERVE_MS));
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), R1_BUDGET_MS);
  let reasoningText = "";
  try {
    const r = await streamReasoner(
      [
        { role: "system", content: scoreSystem },
        { role: "user", content: reasoningUser },
      ],
      {
        onReasoning: (d) => emit({ type: "reasoning", text: d }),
        onContent: (d) => emit({ type: "reasoning", text: d }),
      },
      { model: REASONER, maxTokens: 1200, signal: controller.signal, fastProvider: true }
    );
    reasoningText = (r.reasoning || r.content || "").trim();
  } catch {
    // Genuine failure (not the budget abort): fall back to structuring from the
    // raw candidates rather than dropping the whole run.
    if (!controller.signal.aborted) {
      emit({ type: "status", step: "reason", message: "Reasoning hit a snag; ranking from the candidate research instead" });
    }
  } finally {
    clearTimeout(budget);
    mark(`R1 done (budget was ${R1_BUDGET_MS}ms)`);
  }

  // Stage B — V3 turns the analysis into reliable structured JSON.
  emit({ type: "status", step: "structure", message: "Structuring the shortlisted leads" });

  // Measured on a real 10-lead run: v3.2 emits ~400 output tokens per lead and
  // the provider was managing ~90 tok/s, so ten leads is ~45s of generation --
  // more than the entire function budget, and no reshuffling of the time
  // budget can create throughput that isn't there. Splitting the candidates
  // into DISJOINT chunks structured concurrently turns that into roughly one
  // chunk's wall-clock. Disjoint inputs mean two chunks cannot return the same
  // company, so there is no cross-chunk dedupe to get wrong.
  // Chunks are small on purpose. At 5 leads a chunk still ran past the budget
  // and had to be salvaged mid-lead; at 3 it finishes cleanly, and a chunk that
  // FINISHES is worth more than a bigger one that gets cut off.
  const LEADS_PER_CHUNK = 3;
  // Never make more chunks than the candidate pool can feed -- a chunk asked
  // for more leads than it has candidates simply under-delivers.
  const nChunks = Math.max(
    1,
    Math.min(4, Math.floor(candidates.length / LEADS_PER_CHUNK), Math.ceil(targetCount / LEADS_PER_CHUNK))
  );
  const perChunk = Math.ceil(candidates.length / nChunks);
  const wantPerChunk = Math.ceil(targetCount / nChunks);

  const structureUserFor = (slice: Candidate[], startIdx: number, want: number) => `User request: ${fullPrompt}
Ideal lead: ${plan.criteria}
Mode: ${mode}

Candidates:
${renderContext(slice, startIdx)}

Analyst reasoning to base your selection on:
${reasoningText.slice(0, 3000)}

Output ONLY JSON. Return EXACTLY ${want} leads if the candidates allow it, best first. There are ${slice.length} candidates above, so returning fewer than ${want} means leaving usable prospects unsent. Include every candidate that is a plausible ${mode === "sales" ? "customer" : "sponsor"} worth one email, not only the ideal ones. Only return fewer than ${want} if the remaining candidates are genuinely unsuitable.
{"leads":[{"company","website","industry","location","description","contact_name","contact_role","contact_email","connection_type","connection_note","sponsorship_type","why_fit","reasoning","source_index"}]}
Rules:
- connection_type is one of: "alum" (SFU/Enactus alum tie), "past_sponsor", "ecosystem" (SFU entrepreneurship ecosystem), or "none". Only claim a connection if the text supports it.
- sponsorship_type: for sponsor mode an array subset of ["monetary","in_kind"]; for sales mode 1-3 short angle tags.
- description is one tight sentence. why_fit is ONE sentence under 100 characters${mode === "sales" ? "" : ", naming the specific Enactus SFU project this sponsor best aligns with (e.g. Nourish, Alara, Unify, SKYES, NextSpark, Renovo, SensMS, Second Savour)"}. Open with the reason, not the company name, and never restate the description.
- Where a candidate has a VERIFIED line, take industry and location from it verbatim. Never invent an employee count, revenue figure or founding year.
- reasoning: ONE sentence under 200 characters about THIS company ONLY -- the single strongest piece of concrete evidence from the research, then the first ask it justifies${mode === "sales" ? "" : " and the Enactus SFU project it funds"}. Never mention, compare, or rank other candidates in it. If the evidence is thin, say so instead of padding.
- contact_email only if visible in the text; otherwise null. source_index is the [n] you used.
${mode === "sales" ? "" : "- EXCLUDE entirely (do not output) any other student club, university club/association, or anything requiring Enactus to pay a membership/fee. Only real companies, businesses, or grant-making foundations."}`;

  let parsedLeads: RawLead[] | null = null;
  let structureError: string | null = null;
  let truncated = false;
  // Give structuring everything that is left, minus a slice for persisting.
  // All chunks share one deadline because they run concurrently: the budget is
  // wall-clock, not work, so it is not divided between them.
  const structureCtl = new AbortController();
  const structureAllowance = Math.max(5000, msLeft() - 6000);
  // Measured ~400 output tokens per lead at the full field set, and a run at
  // 1800 truncated mid-JSON even for 5 leads, losing everything. Size the
  // ceiling to what this chunk is actually asked for.
  const structureTokens = Math.min(12_000, Math.max(2500, wantPerChunk * 420 + 600));
  mark(`structure start (allowance ${structureAllowance}ms, ${nChunks} chunks x ${wantPerChunk} leads, ${structureTokens} tok)`);
  const structureTimer = setTimeout(() => structureCtl.abort(), structureAllowance);

  const runChunk = async (idx: number): Promise<RawLead[]> => {
    const startIdx = idx * perChunk;
    const slice = candidates.slice(startIdx, startIdx + perChunk);
    if (!slice.length) return [];
    let body = "";
    try {
      const s = await streamReasoner(
        [
          { role: "system", content: `${scoreSystem} Output only the JSON described, nothing else.` },
          // Never ask a chunk for more leads than it was given candidates. At
          // targetCount=10 with a pool of 6, each chunk saw 3 candidates and was
          // told "there are 3 candidates above, so returning fewer than 5 means
          // leaving usable prospects unsent" -- a false statement, and direct
          // pressure to invent a company.
          { role: "user", content: structureUserFor(slice, startIdx, Math.min(wantPerChunk, slice.length)) },
        ],
        {},
        {
          model: STRUCTURER,
          provider: STRUCTURER_PROVIDER,
          maxTokens: structureTokens,
          signal: structureCtl.signal,
          temperature: 0.3,
          json: true,
        }
      );
      body = s.content;
    } catch (e) {
      // One slow chunk must not lose the chunks that did finish.
      if (!structureError) structureError = (e as Error).message;
    }
    if (!body) return [];

    // Whole-body parse first; fall back to scanning out the leads that did
    // finish. This covers both an abort mid-stream and the model closing
    // cleanly with slightly malformed JSON, which was observed on 3 of 12
    // otherwise healthy calls -- in both cases the finished leads are still
    // in the buffer.
    // Candidates are numbered GLOBALLY in the prompt so chunks need no
    // renumbering, but a model handed a list starting at [10] still often
    // numbers its answers 1,2,3. Unfixed, chunk 4's "source_index: 2" resolved
    // to a chunk-1 candidate and the lead was grounded against a page it was
    // never shown. Only this scope knows startIdx and slice.length.
    const remap = (l: RawLead): RawLead => {
      const si = typeof l?.source_index === "number" ? l.source_index : NaN;
      if (si > startIdx && si <= startIdx + slice.length) return l; // already global
      if (si >= 1 && si <= slice.length) return { ...l, source_index: startIdx + si }; // local
      return { ...l, source_index: undefined }; // unattributable: keep the lead, drop the link
    };

    try {
      const whole = pluck<RawLead>(extractJSON(body), "leads");
      // A valid EMPTY array is a parse success, not a failure: falling through
      // to salvage on it returns whatever sibling object follows "leads": [].
      if (whole) return whole.map(remap);
    } catch {
      // fall through to salvage
    }
    const salvaged = salvageObjects(body) as RawLead[];
    if (salvaged.length) {
      truncated = true;
      mark(`chunk ${idx + 1}: salvaged ${salvaged.length} leads from a partial body (${body.length} chars)`);
    }
    return salvaged.map(remap);
  };

  try {
    const chunks = await Promise.all(Array.from({ length: nChunks }, (_, i) => runChunk(i)));
    const all = chunks.flat();
    if (all.length) parsedLeads = all;
  } finally {
    clearTimeout(structureTimer);
    mark(`structure done (${parsedLeads?.length ?? 0} leads)`);
  }
  if (!parsedLeads?.length && !structureError) {
    structureError = structureCtl.signal.aborted
      ? "ran out of time before structuring finished"
      : "model returned no usable leads";
  }
  if (!parsedLeads?.length) {
    // Keep the cause: a swallowed error here is indistinguishable from "the
    // model had an off day", which hides real outages (bad key, dead model id,
    // truncated output) behind a retry suggestion.
    console.error("structure step failed:", structureError);
    emit({
      type: "error",
      message: `The model did not return usable results (${structureError}). Try again or rephrase.`,
    });
    return;
  }

  const finalized: Lead[] = [];
  let persistError: string | null = null;
  // The system prompt already says to exclude membership bodies, and a real run
  // returned one anyway. The prompt is a suggestion; this is the rule.
  // SFU itself joins the list for the same reason: a run returned "Simon Fraser
  // University" as a sponsor prospect for its own student club.
  // Everything the model produced funnels through here on its way to the board,
  // so this is where the shape is checked once rather than trusted N times.
  // salvageObjects and pluck can both hand back a non-lead (a sibling object, a
  // stray string); without the type test those reach the database.
  const seenNames = new Set<string>();
  const usable = parsedLeads.filter((raw) => {
    if (!raw || typeof raw !== "object" || typeof raw.company !== "string" || !raw.company.trim()) return false;
    if (isMembershipName(raw.company)) {
      dropped.membership_org = (dropped.membership_org ?? 0) + 1;
      return false;
    }
    if (/^(simon fraser|sfu\b)/i.test(raw.company.trim())) return false;
    // Chunks were assumed to be unable to collide because their inputs are
    // disjoint. A real Langley run emitted "Otter Co-Op" three times, each as
    // its own board row: the model names a company mentioned INSIDE a page, and
    // two pages about one firm survive dedupeByDomain. Duplicate cards mean the
    // same sponsor gets emailed twice by two volunteers, which is the failure
    // that costs the relationship.
    //
    // Checked against the board too, not just against this run. The pre-search
    // filter can only compare Exa PAGE TITLES to stored names, and a page title
    // is never a bare company name, so it catches nothing by name -- and the
    // domain half misses every board row whose website is null. This is the
    // first point where a real company name exists to compare.
    const key = companyKey(raw.company);
    if (seenNames.has(key)) {
      dropped.duplicate = (dropped.duplicate ?? 0) + 1;
      return false;
    }
    if (boardNames.has(key)) {
      alreadyKnown++;
      return false;
    }
    seenNames.add(key);
    return true;
  });
  // The prompt asks for exactly targetCount, but a prompt is not a guarantee:
  // enforce the ceiling here so an over-eager run cannot clutter the board or
  // burn credits. Under-delivery is reported honestly below instead.
  for (const raw of usable.slice(0, targetCount)) {
    // `?? 1` silently bound every lead with no source_index to candidate #1 --
    // which is how one Langley candidate became three separate board rows. An
    // unattributable lead now resolves to undefined and simply keeps no site.
    const cand = candidates[(raw.source_index ?? 0) - 1];
    // The fetched URL only. Taking `raw.website ||` first meant the model could
    // supply its own domain, and the nameMatchesDomain guard below would then be
    // checking the model's domain against the model's company name -- the guard
    // grading its own homework, which passes.
    const website = cand ? `https://${cand.domain}` : null;
    const { lead, error, duplicate } = await persistLead(raw, {
      website,
      src: cand?.result,
      org: cand?.org ?? null,
      mode,
      userName,
    });
    if (error && !persistError) persistError = error;
    // Lost a race with the unique index: the company is already on the board,
    // so it is not a new lead and must not be shown as one.
    if (duplicate) {
      alreadyKnown++;
      continue;
    }
    finalized.push(lead);
    emit({ type: "lead", lead });
  }

  // Honour the count out loud. Silently returning 3 when 10 were asked for is
  // exactly the behaviour that made the agent feel like it was not listening;
  // if the funnel genuinely could not fill the order, say so and say why.
  if (finalized.length < targetCount) {
    const reasons = [
      alreadyKnown ? `${alreadyKnown} were already on the board` : "",
      ...dropReasons(dropped),
    ].filter(Boolean);
    emit({
      type: "status",
      step: "shortfall",
      message:
        `You asked for ${askedFor ?? targetCount} and I found ${finalized.length}` +
        (reasons.length ? ` (${reasons.join(", ")})` : "") +
        (truncated
          ? `. The model ran out of time partway through, so these are the ones it finished -- run it again to fill the rest.`
          : `. Try a broader area or a different industry angle for more.`) +
        capTail,
    });
  }

  // A dead database used to fail silently here: cards rendered from in-memory
  // objects and vanished on refresh, which reads as "the agent is flaky"
  // rather than "the database is down". Say it out loud instead. One event,
  // not one per lead.
  if (persistError) {
    emit({
      type: "error",
      message: `These leads were NOT saved and will disappear on refresh. Database error: ${persistError}`,
    });
  }

  // ── 5. Save the search to history ───────────────────────────────────────
  let searchId: string | null = null;
  if (hasDatabaseUrl()) {
    try {
      const [row] = (await db()`
        insert into enactus_searches (prompt, normalized, mode, result_count, created_by_name)
        values (${fullPrompt}, ${norm}, ${mode}, ${finalized.length}, ${userName})
        returning id`) as { id: string }[];
      searchId = row?.id ?? null;
    } catch {
      // non-fatal: history is a nicety, the leads themselves already persisted
    }
  }

  emit({ type: "done", count: finalized.length, searchId });
}

interface RawLead {
  company: string;
  website?: string | null;
  industry?: string | null;
  location?: string | null;
  description?: string | null;
  contact_name?: string | null;
  contact_role?: string | null;
  contact_email?: string | null;
  connection_type?: string;
  connection_note?: string | null;
  sponsorship_type?: string[];
  why_fit?: string | null;
  reasoning?: string | null;
  source_index?: number;
}

async function persistLead(
  raw: RawLead,
  ctx: {
    website: string | null;
    src?: ExaResult;
    org: ApolloOrg | null;
    mode: Mode;
    userName: string;
  }
): Promise<{ lead: Lead; error: string | null; duplicate?: boolean }> {
  // Every claim about a PERSON or a shared history has to survive the evidence
  // we actually fetched. This runs first so there is no path into the database
  // that skips it. Uses the full ExaResult, not the 700-char slice the model
  // saw, so a real contact further down the page is not thrown away.
  const evidence = [
    ctx.src?.title,
    ctx.src?.text,
    ctx.src?.highlights?.join(" "),
    orgFacts(ctx.org),
    ctx.org?.name,
  ]
    .filter(Boolean)
    .join("\n");
  const safe = grounded(raw, evidence, ctx.website ? domainOf(ctx.website) : null);

  const conn = (["alum", "past_sponsor", "ecosystem", "none"].includes(safe.connection_type ?? "")
    ? safe.connection_type
    : "none") as ConnectionType;

  // Apollo's values win over the model's wherever it has them: these are the
  // fields most likely to be confabulated, and Apollo's are looked up.
  const apolloLocation = [ctx.org?.city, ctx.org?.state].filter(Boolean).join(", ") || null;

  // Everything below is inherited from the candidate PAGE. If the company the
  // model named is not that page's owner, the page's domain and the publisher's
  // Apollo facts belong to someone else -- an empty website is a smaller error
  // than a confident link to the wrong company.
  const company = raw.company || ctx.org?.name || "Unknown";
  const siteIsTheirs = nameMatchesDomain(company, ctx.website ? domainOf(ctx.website) : null);

  const row = {
    company,
    website: siteIsTheirs ? ctx.website : null,
    industry: (siteIsTheirs ? ctx.org?.industry : null) ?? raw.industry ?? null,
    description: raw.description ?? null,
    contact_name: safe.contact_name ?? null,
    contact_role: safe.contact_role ?? null,
    contact_email: safe.contact_email ?? null,
    location: (siteIsTheirs ? apolloLocation : null) ?? raw.location ?? null,
    connection_type: conn,
    connection_note: safe.connection_note ?? null,
    sponsorship_type: Array.isArray(raw.sponsorship_type) ? raw.sponsorship_type : [],
    // Retired. The 0-100 number was invented by the model, not computed from
    // anything, and it made volunteers skip lead #7 for no real reason. The
    // column stays so old rows still read; nothing writes it now.
    fit_score: null as number | null,
    why_fit: raw.why_fit ?? null,
    // Per-company only. ctx.reasoningTrace was up to 4000 chars of the SHARED
    // analyst trace about EVERY candidate in the run, so whenever V3 omitted a
    // company-specific reasoning, every card in that run got the same dump
    // comparison-shopping other companies under a panel titled "Why we chose
    // {company}" -- the exact thing the prompt above forbids. why_fit was the
    // next fallback and it is already on the card, so it only made the
    // disclosure a duplicate. Nothing to say is honest.
    reasoning: raw.reasoning?.trim() || null,
    sources: ctx.src ? [{ url: ctx.src.url, title: ctx.src.title ?? undefined }] : [],
    status: "prospects" as const,
    mode: ctx.mode,
    created_by_name: ctx.userName,
  };

  let error: string | null = null;
  if (hasDatabaseUrl()) {
    try {
      const [saved] = await db()`
        insert into enactus_leads (
          company, website, industry, description, contact_name, contact_role,
          contact_email, location, connection_type, connection_note,
          sponsorship_type, fit_score, why_fit, reasoning, sources, status,
          mode, created_by_name
        ) values (
          ${row.company}, ${row.website}, ${row.industry}, ${row.description},
          ${row.contact_name}, ${row.contact_role}, ${row.contact_email},
          ${row.location}, ${row.connection_type}, ${row.connection_note},
          ${row.sponsorship_type}::text[], ${row.fit_score}, ${row.why_fit},
          ${row.reasoning}, ${JSON.stringify(row.sources)}::jsonb, ${row.status},
          ${row.mode}, ${row.created_by_name}
        )
        on conflict do nothing
        returning *`;
      if (saved) return { lead: saved as Lead, error: null };
      // No row means the unique index rejected it as a company already on the
      // board -- NOT a failure. Reported as an error, this showed the volunteer
      // a red database message for the one case the constraint exists to
      // handle. Hand back the row that is already there and say so.
      const [existing] = await db()`
        select * from enactus_leads
        where mode = ${row.mode} and lower(btrim(company)) = lower(btrim(${row.company}))
        limit 1`;
      if (existing) return { lead: existing as Lead, error: null, duplicate: true };
      error = "insert returned no row";
    } catch (e) {
      error = (e as Error).message;
    }
  } else {
    error = "DATABASE_URL missing";
  }

  // Still hand back a usable card so the run's work isn't lost, but the caller
  // now knows it is unsaved and tells the user.
  const now = new Date().toISOString();
  return {
    lead: { id: crypto.randomUUID(), board_order: 0, created_at: now, updated_at: now, ...row } as Lead,
    error,
  };
}
