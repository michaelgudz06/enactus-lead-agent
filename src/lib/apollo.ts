// Apollo.io company enrichment.
//
// Plan scope, measured against this account's key on 2026-08-15:
//   organizations/enrich        200
//   organizations/bulk_enrich   200   (hard limit: 10 domains per call)
//   organizations/job_postings  200
//   mixed_companies/search      403   "not included in your Free plan"
//   people/match                403
//   mixed_people/search         403
//
// So Apollo cannot discover companies here and cannot supply contact names or
// emails. What it can do, in ~0.4s for 10 domains, is tell us whether a
// candidate is a real, currently-staffed company in the right province. That
// is the check that kills the defunct-company / national-chain / event-page /
// membership-org noise a web search returns, and it is deterministic, which
// prompt rules never are.

// .ts specifier on purpose: scripts/selfcheck.ts loads this module under
// `node --experimental-strip-types`, which resolves only explicit extensions.
// tsconfig sets allowImportingTsExtensions so the Next build reads it too.
import { baseName } from "./firecrawl.ts";

const BULK_URL = "https://api.apollo.io/api/v1/organizations/bulk_enrich";
const MAX_PER_CALL = 10;

export interface ApolloOrg {
  domain: string;
  name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  employees: number | null;
  industry: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  foundedYear: number | null;
}

export function hasApolloKey(): boolean {
  const k = process.env.APOLLO_API_KEY;
  return Boolean(k && !k.startsWith("REPLACE"));
}

function toOrg(raw: Record<string, unknown>): ApolloOrg | null {
  const domain = String(raw.primary_domain ?? "").toLowerCase();
  if (!domain) return null;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    domain,
    name: str(raw.name),
    city: str(raw.city),
    state: str(raw.state),
    country: str(raw.country),
    employees: num(raw.estimated_num_employees),
    industry: str(raw.industry),
    phone: str(raw.phone),
    linkedinUrl: str(raw.linkedin_url),
    foundedYear: num(raw.founded_year),
  };
}

/**
 * Enrich up to any number of domains, 10 per Apollo call, all chunks in
 * parallel. Returns a map keyed by the domain that was ASKED for, so callers
 * can tell "Apollo has no record" (value null) apart from "we never asked".
 *
 * Enrichment is an optimisation, never a gate on the run itself: any failure
 * degrades to an empty map so a bad Apollo day cannot break lead generation.
 */
export async function enrichDomains(
  domains: string[],
  opts: { signal?: AbortSignal } = {}
): Promise<Map<string, ApolloOrg | null>> {
  const out = new Map<string, ApolloOrg | null>();
  const key = process.env.APOLLO_API_KEY;
  const wanted = [...new Set(domains.map((d) => d.toLowerCase()).filter(Boolean))];
  if (!key || !wanted.length) return out;
  for (const d of wanted) out.set(d, null);

  const chunks: string[][] = [];
  for (let i = 0; i < wanted.length; i += MAX_PER_CALL) chunks.push(wanted.slice(i, i + MAX_PER_CALL));

  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await fetch(BULK_URL, {
          method: "POST",
          headers: {
            "x-api-key": key,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ domains: chunk }),
          signal: opts.signal,
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { organizations?: unknown[] };
        for (const raw of data.organizations ?? []) {
          if (!raw || typeof raw !== "object") continue;
          const org = toOrg(raw as Record<string, unknown>);
          // Apollo answers with its own canonical domain, which can differ from
          // the one we asked about (redirects, www, country variants). Only
          // record it against a domain we actually asked for.
          if (org && out.has(org.domain)) out.set(org.domain, org);
        }
      } catch {
        // Leave this chunk's domains as null (unverified) and carry on.
      }
    })
  );

  return out;
}

// Apollo's own industry label for trade boards, chambers and member
// associations. Enactus would be paying these to join, not receiving from them.
const MEMBERSHIP_INDUSTRIES = new Set(["civic & social organization"]);
const MEMBERSHIP_NAME =
  /\b(board of trade|chamber of commerce|business improvement (association|area)|trade association)\b/i;

/**
 * Name test for membership bodies, usable without an Apollo record.
 *
 * A real run leaked "Burnaby Board of Trade (BBOT)" onto the board: Apollo has
 * no record for its members.bbot.ca subdomain, so the org-based check never
 * ran. The name itself is sufficient evidence, wherever it comes from, so this
 * is applied to the candidate title AND to the company name the model finally
 * emits -- the model can name an organisation the candidate title never did.
 */
export function isMembershipName(name: string | null | undefined): boolean {
  return Boolean(name && MEMBERSHIP_NAME.test(name));
}

// "duplicate" is never returned by disqualify() -- it is a drop reason the
// finalize step records. It lives here so every reason shown to the user has a
// sentence, which is the whole point of reporting a shortfall.
export type Disqualifier = "defunct" | "wrong_region" | "membership_org" | "duplicate";

// Identity for "is this the same company?".
//
// Exact lowercase matching was not enough. One real Burnaby run delivered
// "Xenon Pharmaceuticals Inc." and "Xenon Pharmaceuticals" as two cards, and
// "Grosvenor" and "Grosvenor (Burnaby FC)" as two more -- four cards, two
// companies, and two volunteers about to email the same sponsor. The variants
// are always the same three things: a trailing legal suffix, a parenthetical
// qualifier, and punctuation.
const LEGAL_SUFFIX =
  /\b(inc|incorporated|ltd|limited|llc|llp|lp|corp|corporation|co|company|holdings|group|plc|gmbh|sa|nv|pty)\b\.?/g;

export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // "Grosvenor (Burnaby FC)" -> "Grosvenor"
    .replace(/['’]/g, "") // deleted, not spaced: Nature's Path == Natures Path
    .replace(/[.,&/-]/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const DISQUALIFIER_LABEL: Record<Disqualifier, string> = {
  defunct: "no longer operating",
  wrong_region: "headquartered outside the target region",
  membership_org: "a membership body Enactus would pay to join",
  duplicate: "the same company returned twice",
};

/**
 * Decide whether Apollo gives us positive evidence that a candidate is not a
 * viable sponsor.
 *
 * Deliberately one-sided: we only drop on evidence of wrongness, never on
 * absence of evidence. Apollo's coverage of very small local businesses is
 * poor, and those are exactly the corner-store sponsors this club wants, so a
 * missing record must never disqualify -- it only means "unverified".
 */
export function disqualify(
  org: ApolloOrg | null,
  opts: { province?: string | null; name?: string | null } = {}
): Disqualifier | null {
  // The name test is the one check that does not need an Apollo record: the
  // name is itself the evidence. Everything below still requires Apollo to have
  // positively told us something is wrong.
  //
  // Known limit: `!org` means "Apollo said nothing", and a 429 or an exhausted
  // credit balance is indistinguishable here from a genuine no-record. On a bad
  // Apollo day that silently switches the wrong_region and defunct checks off
  // while the run still reports full confidence. Letting the candidate through
  // is the right default for a corner store with no Apollo footprint; the fix
  // for the other case is for enrichDomains to report its failure count up.
  if (isMembershipName(org?.name ?? opts.name)) return "membership_org";
  if (!org) return null;
  if (org.employees === 0) return "defunct";
  if (org.industry && MEMBERSHIP_INDUSTRIES.has(org.industry.toLowerCase())) {
    return "membership_org";
  }
  if (opts.province && org.state && org.state.toLowerCase() !== opts.province.toLowerCase()) {
    return "wrong_region";
  }
  return null;
}

// Only gate on region when the request clearly names one, and only for places
// we can map to a province with confidence.
const BC_HINT = /\b(british columbia|b\.?c\.?|vancouver|burnaby|surrey|richmond|coquitlam|langley|delta|new westminster|north shore|lower mainland|metro vancouver|fraser valley)\b/i;

export function provinceFromRequest(...texts: (string | null | undefined)[]): string | null {
  const blob = texts.filter(Boolean).join(" ");
  return BC_HINT.test(blob) ? "British Columbia" : null;
}

// ── Grounding ─────────────────────────────────────────────────────────────
// The model is allowed to write prose. It is not allowed to assert facts about
// people. Every field below is dropped unless it appears in the evidence we
// actually fetched, because the downstream cost is not a bad card: the email
// drafter injects contact name, role and connection type into the draft as
// stated fact, so an invented "Head of Community Partnerships" or a spurious
// past-sponsor tie goes out to a real Burnaby company over the club's name.
// The Lower Mainland sponsor pool is small and there is one first impression
// per company.

const norm = (s: string) =>
  s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export interface Groundable {
  contact_name?: string | null;
  contact_role?: string | null;
  contact_email?: string | null;
  connection_type?: string;
  connection_note?: string | null;
}

/**
 * Strip any claim the fetched evidence does not support.
 *
 * Deliberately destructive: a nulled contact renders as a plain company card,
 * which is honest and costs the team nothing (they were cold-emailing anyway).
 * A fabricated one costs a sponsor.
 */
export function grounded<T extends Groundable>(
  raw: T,
  evidence: string,
  siteDomain: string | null
): T {
  const hay = norm(evidence);
  const rawHay = evidence.toLowerCase();
  const seen = (v: string | null | undefined) => {
    const n = v ? norm(v) : "";
    return Boolean(n && n.length > 2 && hay.includes(n));
  };

  const out: T = { ...raw };
  if (!seen(out.contact_name)) out.contact_name = null;
  // A role without a person to attach it to is noise on the card.
  if (!out.contact_name || !seen(out.contact_role)) out.contact_role = null;

  const email = (out.contact_email ?? "").trim().toLowerCase();
  const emailDomain = email.split("@")[1] ?? "";
  // Fails CLOSED on a missing domain. `!siteDomain ||` meant "nothing to check
  // against, so allow anything", which let a gmail.com address through whenever
  // the lead had no confirmed website -- exactly the leads least worth trusting.
  const domainOk =
    Boolean(siteDomain) && (emailDomain === siteDomain || emailDomain.endsWith(`.${siteDomain}`));
  if (!(EMAIL_RE.test(email) && rawHay.includes(email) && domainOk)) out.contact_email = null;

  // A connection chip is a claim about shared history, and "Past Sponsor" is
  // the one a volunteer is most likely to repeat out loud to the sponsor.
  const claimsSFU = /simon fraser|\bsfu\b/i.test(evidence);
  const claimsEnactus = /enactus/i.test(evidence);
  const c = out.connection_type;
  const ok =
    (c === "alum" && claimsSFU) ||
    (c === "ecosystem" && claimsSFU) ||
    (c === "past_sponsor" && claimsEnactus);
  if (c && c !== "none" && !ok) {
    out.connection_type = "none";
    out.connection_note = null;
  }
  return out;
}

const NAME_STOP = new Set(["the", "of", "and", "inc", "ltd", "llc", "corp", "co", "group", "canada"]);

/**
 * Does this company name plausibly belong to this domain?
 *
 * A candidate is one web page, but the model reads the page and can name a
 * company mentioned INSIDE it. When it does, source_index still points at the
 * page, so the lead inherits the article's domain and the article publisher's
 * Apollo facts. A real run produced "Renaissance Coffee" attached to sfu.ca and
 * "ABC Recycling" attached to recyclingproductnews.com with the industry
 * "marketing & advertising" -- a volunteer would email the wrong company.
 *
 * Matching the name prefix against the host catches this without dropping the
 * lead: a mismatch means we withhold the site and the borrowed facts, not that
 * the company is fake.
 */
export function nameMatchesDomain(
  company: string | null | undefined,
  domain: string | null | undefined
): boolean {
  if (!company || !domain) return false;
  // baseName, not split(".")[0]: the old version took the SUBDOMAIN, so
  // "The Bike Shop" matched shop.mec.ca.
  const host = baseName(domain).replace(/[^a-z0-9]/g, "");
  // Short hosts are generic enough to match almost anything: "Fairmont Hotels"
  // matched ai.com and "Community Savings Credit Union" matched unity.com.
  if (host.length < 4) return false;
  const tokens = norm(company).split(" ").filter((t) => t && !NAME_STOP.has(t));
  if (!tokens.length) return false;
  // The name must START with the host, rather than the host merely CONTAINING a
  // leading word of the name. That containment test is what matched West Coast
  // Reduction to westjet.com and Nature's Path to naturesbounty.com -- ten such
  // pairs were reproduced from one run. Since this predicate now gates which
  // site Firecrawl scrapes for a contact address, a false positive here is a
  // real email to the wrong company, so it fails closed.
  const cands = [tokens[0], tokens.slice(0, 2).join(""), tokens.slice(0, 3).join(""), tokens.join("")];
  return cands.some((p) => p.length >= 4 && (p === host || p.startsWith(host)));
}

/** One compact line of verified facts to hand the model instead of guesses. */
export function orgFacts(org: ApolloOrg | null): string {
  if (!org) return "";
  const bits: string[] = [];
  if (org.employees != null) bits.push(`~${org.employees} employees`);
  if (org.industry) bits.push(org.industry);
  const where = [org.city, org.state].filter(Boolean).join(", ");
  if (where) bits.push(where);
  if (org.foundedYear) bits.push(`founded ${org.foundedYear}`);
  if (org.phone) bits.push(org.phone);
  return bits.length ? `VERIFIED (Apollo): ${bits.join(" · ")}` : "";
}
