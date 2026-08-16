// Firecrawl contact discovery, run on demand from a lead card.
//
// Why this exists: Apollo's free tier returns 403 on people/match and
// mixed_people/search, so every lead ships with contact_email: null and the
// volunteer has to go find an address by hand. Exa's *discovery* snippets
// rarely carry a named contact, but a targeted on-domain search does -- it is
// the last step of the cascade below.
//
// Why it is NOT in the agent run: a scrape is 2-5s per URL (measured below) and
// the run already spends its whole 60s budget. On demand also means credits are
// only spent on leads someone actually intends to email.
//
// Measured 2026-08-15 against this key:
//   POST /v2/map    ~1s    returns candidate URLs AND descriptions that
//                          sometimes already contain the email
//   POST /v2/scrape 2.3-5.2s per URL
//   binnie.com/contact scraped to 3770 chars with NO email in the markdown,
//   but map's description for the same page had it -- so both are used.
//
// NOTHING here asks a model for an email address. Addresses are regex-extracted
// from fetched text and then required to belong to the company's own domain,
// which is the same contract grounded() enforces on model output.

// .ts specifier on purpose: scripts/selfcheck.ts loads this module under
// `node --experimental-strip-types`, which resolves only explicit extensions.
// tsconfig sets allowImportingTsExtensions so the Next build reads it too.
import { exaSearch, hasExaKey } from "./exa.ts";

const BASE = "https://api.firecrawl.dev/v2";

function hasFirecrawlKey(): boolean {
  const k = process.env.FIRECRAWL_API_KEY;
  return Boolean(k && !k.startsWith("REPLACE"));
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Compound public suffixes we are likely to meet. Not a full public-suffix
// list: this only has to be right for the Lower Mainland businesses this club
// contacts, and being wrong costs a missed match, never a wrong one.
const COMPOUND_TLDS = new Set(["co.uk", "com.au", "co.nz", "co.jp", "com.br", "bc.ca"]);

/**
 * The registrable label of a host: "herbaland" for both herbaland.com and
 * herbaland.ca.
 *
 * Comparing full domains was too strict in practice -- herbaland.com publishes
 * pr@herbaland.ca, and rejecting that loses a real contact. Comparing the label
 * accepts the .ca/.com pair while still rejecting an unrelated domain.
 */
export function baseName(host: string | null | undefined): string {
  if (!host) return "";
  const clean = host.toLowerCase().trim().replace(/^www\./, "").replace(/\.$/, "");
  const parts = clean.split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const lastTwo = parts.slice(-2).join(".");
  const idx = COMPOUND_TLDS.has(lastTwo) ? parts.length - 3 : parts.length - 2;
  return parts[idx] ?? "";
}

// Hosts we must never map or scrape, checked by registrable label so
// linkedin.ca is covered by "linkedin".
//
// rankUrls already keeps these OUT of the pages we read, but only because they
// fail to match the company's own base name. That protection inverts when the
// stored website IS the social profile: baseName("linkedin.com") is "linkedin",
// every linkedin.com/* link then "belongs" to it, and the guard would wave
// through exactly the scrape this project has a standing rule against. Checked
// before the map call so no request is ever made.
const BANNED_HOSTS = new Set([
  "linkedin",
  "facebook",
  "instagram",
  "twitter",
  "x",
  "youtube",
  "tiktok",
  "yelp",
  "crunchbase",
  "indeed",
  "glassdoor",
]);

export function isBannedHost(host: string): boolean {
  return BANNED_HOSTS.has(baseName(host));
}

export function hostOf(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Emails that belong to this company, deduped, lowercase. */
export function companyEmails(text: string, siteHost: string): string[] {
  const want = baseName(siteHost);
  if (!want) return [];
  const found = text.match(EMAIL_RE) ?? [];
  const out = new Set<string>();
  for (const raw of found) {
    const email = raw.toLowerCase().replace(/[.,;:)]+$/, "");
    const domain = email.split("@")[1] ?? "";
    if (baseName(domain) === want) out.add(email);
  }
  return [...out];
}

// Mailboxes a sponsorship ask should go to, best first. A generic info@ is a
// legitimate target here -- the club is cold-emailing either way, and a
// published address is likelier to be read than a guessed personal one.
const PREFERRED = [
  // `fundraising` earns its place the hard way: fundraising@purdys.com was
  // scraped, ranked below customerservice@, and thrown away.
  /^(sponsorships?|sponsor|partnerships?|partner|community|giving|donations?|fundraising)$/,
  /^(marketing|communications?|comms|media|pr)$/,
  /^(info|hello|contact|inquiries|enquiries|general)$/,
];

// Desks that exist to handle unhappy customers, warranty claims and job
// applications. A sponsorship ask sent here is filed by someone whose job is to
// close tickets, and it is the wrong first impression besides.
// Two tests rather than one alternation: the prefixes anchor at the start of
// the mailbox head, while `cares` anchors at its end -- Fresh Slice publishes
// freshslicecares@, where the tell is the suffix.
export function isComplaintInbox(email: string): boolean {
  const head = localHead(email);
  return (
    /^(customer|consumer|support|help|complaint|warranty|return|refund|billing|order|career|resume|job)/.test(head) ||
    /cares?$/.test(head)
  );
}

// Match the first segment of the mailbox, not the whole thing: Mowi publishes
// donations.canadaeast@ and media@, and anchoring on the full local part picked
// the media desk over the donations desk.
const localHead = (email: string) => email.split("@")[0].split(/[.\-_+]/)[0];

export function pickEmail(emails: string[]): string | null {
  if (!emails.length) return null;
  for (const re of PREFERRED) {
    const hit = emails.find((e) => re.test(localHead(e)));
    if (hit) return hit;
  }
  // No recognised mailbox: prefer a personal-looking address over noreply, and
  // a complaint desk only when it is the only thing on offer.
  //
  // This fallback took usable[0], which is first-INSERTED, and /contact pages
  // list the customer-service address first -- so all three lookups this app has
  // ever run picked a complaint desk while holding a better address in the same
  // array (a fundraising desk in one case, a named person in the other two).
  // First-found is also permanent downstream, because the write path
  // coalesces, so the wrong pick here is a wrong pick forever.
  const usable = emails.filter((e) => !/^(no-?reply|donotreply|postmaster|abuse|privacy)@/.test(e));
  return usable.find((e) => !isComplaintInbox(e)) ?? usable[0] ?? emails[0] ?? null;
}

/** Pages worth reading for a contact, best first. */
const PATH_RANK = [
  /\/(contact|contact-us|contactez)/i,
  /\/(about|about-us|our-story)/i,
  /\/(team|our-team|people|leadership|staff)/i,
  /\/(community|sponsorship|partnerships?|giving|csr|sustainability)/i,
];

export function rankUrls(urls: string[], siteHost: string): string[] {
  const want = baseName(siteHost);
  // Only ever read the company's OWN site. This is what keeps LinkedIn and
  // other social profiles out: they can never match the company's base name,
  // so they are unreachable from here rather than merely discouraged.
  const own = urls.filter((u) => baseName(hostOf(u)) === want);
  const score = (u: string) => {
    const i = PATH_RANK.findIndex((re) => re.test(u));
    return i === -1 ? PATH_RANK.length : i;
  };
  return own.sort((a, b) => score(a) - score(b) || a.length - b.length);
}

// ── Named people ──────────────────────────────────────────────────────────
// A generic info@ gets a sponsorship ask delivered; a named owner gets it
// answered. Both are worth having, so the lookup returns both.
//
// Same contract as the address extraction above, and for the same reason: a
// name, a title and a personal address survive only if they sit beside each
// other in text we actually fetched. Nothing is completed, inferred or asked of
// a model, because a plausible-looking invented person is exactly how a cold
// email reaches a stranger over the club's name.

// Titles that can say yes to a student club, best first. VP and Director are
// last on purpose: any company big enough to have them holds the sponsorship
// budget somewhere else entirely, and their inbox is unreachable anyway.
const ROLE_TIERS: RegExp[] = [
  // The lookbehind is load-bearing: "Vice President" contains "president", and
  // without it every VP outranked the owner standing next to them.
  /\b(?:co[-\s]?)?(?:owner|founder)\b|(?<!vice[\s-])\bpresident\b|\bproprietor\b|\bgeneral manager\b|\bmanaging partner\b|\bc\.?e\.?o\.?\b|\bchief executive\b/i,
  /\b(?:marketing|brand|communications?|community|social media)\s+(?:manager|director|lead|coordinator|specialist)\b|\b(?:director|head|vp)\s+of\s+(?:marketing|brand|communications?)\b/i,
  /\bcommunity\s+(?:investment|engagement|relations|partnerships?|giving|impact)\b|\bcorporate social responsibility\b|\bcsr\b|\bsponsorships?\b|\bphilanthropy\b|\bdonations?\b/i,
  /\bvice[-\s]?president\b|\bvp\b|\bdirector\b|\bhead of\b/i,
];

// Two or three capitalised words, middle initial allowed. A word may carry an
// internal capital ("O'Brien", "MacLeod", "Jean-Luc") but must end in a
// lowercase letter, which is what keeps SHOUTED headings out.
const NAME_WORD = "[A-Z][A-Za-zà-öø-ÿ'’-]*[a-zà-öø-ÿ]";
const NAME_RE = new RegExp(`\\b(${NAME_WORD}(?:\\s+(?:[A-Z]\\.|${NAME_WORD})){1,2})\\b`, "g");

// Capitalised page furniture that parses as a person. The list is short on
// purpose: the real guard is that a name only counts when it is adjacent to a
// title, which no navigation label ever is.
const NOT_NAME = new Set([
  "contact", "us", "our", "your", "team", "about", "home", "read", "learn", "more", "view", "meet",
  "privacy", "policy", "terms", "conditions", "cookie", "copyright", "rights", "reserved", "site",
  "map", "menu", "skip", "main", "content", "email", "phone", "call", "book", "now", "order",
  "online", "shop", "store", "hours", "location", "locations", "careers", "news", "blog", "press",
  "customer", "service", "services", "head", "office", "get", "started", "sign", "up", "in",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december",
  "street", "avenue", "road", "drive", "suite", "unit", "west", "east", "north", "south",
  "canada", "british", "columbia", "vancouver", "burnaby", "surrey", "richmond", "coquitlam",
  // Businesses get talked about in the same sentence as their owner, and
  // "Neates Coffee" parses as a person otherwise.
  "coffee", "cafe", "roasters", "roasting", "bakery", "market", "brewing", "brewery", "kitchen",
  "print", "printing", "design", "studio", "group", "foods", "farms", "supply", "solutions",
  // Legal-entity and collective words. Measured: safeway.ca yielded "Sobeys Inc
  // — President" and longos.com yielded "Longo Brothers Fruit — President",
  // both of which are companies standing next to a title, and both of which
  // would have addressed a cold email to a corporation by first name.
  "inc", "ltd", "llc", "corp", "corporation", "company", "co", "holdings", "enterprises",
  "industries", "ventures", "partners", "associates", "brothers", "bros", "sons", "limited",
  // Department and rank words. A leadership page reads "Vice-President,
  // Inclusive Banking", and vancity.com produced both "Inclusive Banking" and
  // "Chief Operating Officer" as people -- ROLE_TIERS cannot catch these
  // because neither phrase is a title this project ranks.
  "chief", "officer", "vice", "executive", "banking", "sales", "retail", "operations", "operating",
  "finance", "financial", "technology", "information", "risk", "credit", "member", "members",
  "business", "development", "strategy", "wealth", "commercial", "corporate", "digital", "product",
  "engineering", "human", "resources", "administration", "marketing", "communications", "community",
  "partnerships", "lending", "insurance", "investment",
]);

// A call to action is capitalised like a name and sits anywhere on a page.
// Measured: trailappliances.com produced "See Job Openings" as the person.
// Anchored to the first word because the verb is what makes it an instruction
// -- "Mark Read" is a real name and must survive.
const LEAD_VERB =
  /^(see|view|read|learn|get|find|meet|join|shop|book|call|order|visit|explore|discover|download|subscribe|apply|sign|start|browse|watch|check|request|schedule|become|support|donate|give|send|ask|click|follow|share|save|buy|try|enjoy|welcome|introducing|announcing)$/i;

// Only pages a company uses to publish its OWN people, as an allowlist. A
// blocklist was tried first and there is no end to the page types that talk
// about people without publishing them: a customer review ("especially the
// owner"), a blog post ("the owner of a Los Angeles cafe"), a product page
// quoting a partner's CEO, and a community-spotlight post about a different
// organisation each produced a confident wrong contact on a real lead.
const PEOPLE_TOKENS = new Set([
  "about", "team", "people", "staff", "leadership", "management", "executive", "executives",
  "board", "contact", "community", "sponsorship", "partnership", "partnerships", "giving",
  "story", "crew", "founders", "who",
]);
// Checked first, so /community qualifies and /community-spotlight does not.
const PROSE_TOKENS = new Set([
  "blog", "blogs", "news", "press", "article", "articles", "post", "posts", "event", "events",
  "recipe", "recipes", "product", "products", "collections", "spotlight", "stories", "review",
  "reviews",
]);

// Applied where pages are fetched rather than inside extractPeople(), which
// stays a pure text-to-people function: the URL is evidence about the page, not
// about the text on it.
function isPeoplePage(url: string): boolean {
  const tokens = url
    .split(/[?#]/)[0]
    .split("/")
    .slice(3) // past the protocol and host
    .flatMap((s) => s.toLowerCase().split(/[-_.]/));
  if (tokens.some((t) => PROSE_TOKENS.has(t))) return false;
  return tokens.some((t) => PEOPLE_TOKENS.has(t));
}

// Published as part of a name without being part of it. Stripped rather than
// rejected: "John Neate Jr." is a person, "John Jr." on its own is not enough
// of one to email.
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|phd|md|mba|cpa|cfa|bsc)$/;

/** The person in a candidate phrase, or null if it is not one. */
function personName(s: string, siteLabel: string): string | null {
  // A title is not a person: "General Manager" and "Community Investment" both
  // parse as two capitalised words.
  if (ROLE_TIERS.some((re) => re.test(s))) return null;
  const tokens = s.split(/\s+/);
  while (tokens.length && NAME_SUFFIX.test(tokens[tokens.length - 1].replace(/[^a-z]/gi, "").toLowerCase())) {
    tokens.pop();
  }
  if (tokens.length < 2 || tokens.length > 3) return null;
  const words = tokens.map((t) => t.replace(/[^A-Za-zà-öø-ÿ']/g, "").toLowerCase());
  if (words.filter((w) => w.length > 1).length < 2) return null;
  if (words.some((w) => NOT_NAME.has(w))) return null;
  if (LEAD_VERB.test(words[0])) return null;
  // "Burnaby Print" on burnabyprint.com is the company, not its owner. Compared
  // by registrable label so a real person who shares a name with the business
  // ("Cathy Stong" at stongs.com) still survives.
  const joined = words.join("");
  if (siteLabel && (joined.includes(siteLabel) || siteLabel.includes(joined))) return null;
  return tokens.join(" ");
}

/**
 * Markdown to plain lines. Link labels are kept because a team card's name is
 * usually the label of a link to their bio, and table pipes become separators
 * so one row stays one line.
 */
function plainLines(md: string): string[] {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, " ")
    .replace(/\|/g, " , ")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

interface NameHit {
  name: string;
  raw: string;
  start: number;
  end: number;
}

function namesIn(line: string, siteLabel: string): NameHit[] {
  const out: NameHit[] = [];
  for (const m of line.matchAll(NAME_RE)) {
    const name = personName(m[1], siteLabel);
    const start = m.index ?? 0;
    if (name) out.push({ name, raw: m[1], start, end: start + m[1].length });
  }
  return out;
}

/**
 * A line that is a name and nothing else -- the top of a team card, where the
 * title sits on the line below.
 *
 * The ratio is what makes this safe to reach across lines at all: a sentence
 * that merely contains a name is not a card, and burnabyprint.com pairs
 * "...especially the owner" with the name of the customer who wrote the review
 * above it if you let it.
 */
function nameCard(line: string | undefined, siteLabel: string): NameHit | undefined {
  if (!line || line.length > 40) return undefined;
  const [hit] = namesIn(line, siteLabel);
  return hit && hit.raw.length / line.length >= 0.5 ? hit : undefined;
}

/**
 * Is this address this person's, rather than the colleague's listed above them?
 * Only the forms a company actually uses. An address that does not encode the
 * name is left as a company address, never attributed to them.
 */
export function emailBelongsTo(email: string, name: string): boolean {
  const local = email.split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
  const parts = name.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z]/g, "")).filter((t) => t.length > 1);
  if (!local || parts.length < 2) return false;
  const [first, last] = [parts[0], parts[parts.length - 1]];
  return [first, last, first + last, last + first, first[0] + last, first + last[0]].includes(local);
}

export interface ContactPerson {
  name: string;
  role: string;
  email: string | null;
  tier: number;
  sourceUrl: string;
}

// Cloned once with /g so one line can yield every person on it: a leadership
// roster is often a single comma-separated line.
const ROLE_TIERS_G = ROLE_TIERS.map((re) => new RegExp(re.source, "gi"));

// How far apart a name and a title may be published and still be the same
// person. Beyond this on one line they are two different sentences.
const MAX_GAP = 40;

const SEP_EDGE = /^[\s,.·|:;–—-]+|[\s,.·|:;–—-]+$/g;

/** People published on one page, in page order. */
export function extractPeople(md: string, siteHost: string, sourceUrl: string): ContactPerson[] {
  const siteLabel = baseName(siteHost);
  const lines = plainLines(md);
  const out: ContactPerson[] = [];
  lines.forEach((line, i) => {
    const names = namesIn(line, siteLabel);
    ROLE_TIERS_G.forEach((re, tier) => {
      for (const m of line.matchAll(re)) {
        const at = m.index ?? 0;
        const after = at + m[0].length;
        // Pair the title with the name published NEXT TO it, never the first
        // name on the line. jjbeancoffee.com publishes five people on one line
        // and the first of them is not the CEO.
        const hit =
          names.filter((n) => n.end <= at && at - n.end <= MAX_GAP).pop() ??
          names.find((n) => n.start >= after && n.start - after <= MAX_GAP) ??
          // Team cards put the name on the line above the title. Only reached
          // from a short line, because a paragraph mentioning "the owner" is
          // prose about someone, not a card belonging to the name near it.
          (line.length <= 60
            ? (nameCard(lines[i - 1], siteLabel) ?? nameCard(lines[i + 1], siteLabel))
            : undefined);
        if (!hit) continue;
        // A name and a title sharing a line with an 1800s or 1900s year is the
        // company's history, not its staff. This is how "Richard Carmon Purdy,
        // founder" got onto a card for a company founded in 1907, and how his
        // name ended up on a draft addressed to customerservice@.
        //
        // Known limit: misses a living founder introduced with e.g. "since 1998",
        // but they almost always appear on /team without a year too. Wrong in
        // the safe direction -- a missing name costs a lookup, a dead one costs
        // the email.
        if (/\b1[89]\d\d\b/.test(line)) continue;
        // Prefer the published title verbatim; fall back to the matched phrase
        // when the line holds several people or a paragraph, so the card never
        // shows someone else's title or a whole sentence. Addresses come out
        // first: a table row is one line here, and "Marketing Manager ,
        // priya@acme.com ," is not a job title.
        const label = line
          .replace(hit.raw, " ")
          .replace(EMAIL_RE, " ")
          .replace(/\s+/g, " ")
          .replace(SEP_EDGE, "")
          .trim();
        // A title is a noun phrase. Anything that asks a question or runs on
        // like a sentence is the surrounding copy, not the job: measured,
        // trailappliances.com paired a title match with "Looking for donations
        // or community support?" and showed it as the person's role.
        const titleish =
          label && label.length <= 60 && !/[?!]/.test(label) && label.split(/\s+/).length <= 7;
        const role = names.length <= 1 && titleish ? label : m[0];
        const near = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
        const email = companyEmails(near, siteHost).find((e) => emailBelongsTo(e, hit.name)) ?? null;
        out.push({ name: hit.name, role, email, tier, sourceUrl });
      }
    });
  });
  return out;
}

/** Best first, one entry per person. */
function rankPeople(people: ContactPerson[]): ContactPerson[] {
  const best = new Map<string, ContactPerson>();
  for (const p of people) {
    const key = p.name.toLowerCase();
    const cur = best.get(key);
    // The same person on two pages: keep the better title and an address from
    // either page.
    best.set(key, cur ? { ...(p.tier < cur.tier ? p : cur), email: cur.email ?? p.email } : p);
  }
  // Within a tier, whoever published an address wins: that is the difference
  // between a name to look up and a person to email.
  return [...best.values()].sort(
    (a, b) => a.tier - b.tier || Number(Boolean(b.email)) - Number(Boolean(a.email))
  );
}

interface PostResult {
  data: Record<string, unknown> | null;
  timedOut: boolean;
  /** HTTP status, or 0 when the call never got an answer. */
  status: number;
}

// Per-call cap, not just the route's overall one. /map has been measured at 1s
// and at 17s on the same key; under a single 25s budget one slow map consumes
// everything and the scrapes that actually find the address never run. Each
// call now fails fast so the next one still gets its turn.
const CALL_TIMEOUT_MS = 8_000;

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<PostResult> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return { data: null, timedOut: false, status: 0 };
  const timer = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timer]) : timer;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: merged,
      cache: "no-store",
    });
    // The status is carried out, not swallowed: a 429 answered in 200ms is
    // otherwise indistinguishable from a site that publishes no address, and
    // the volunteer is told the second thing. Two maps per lookup makes the
    // free tier's rate limit a routine event rather than a rare one.
    if (!res.ok) return { data: null, timedOut: false, status: res.status };
    return { data: (await res.json()) as Record<string, unknown>, timedOut: false, status: res.status };
  } catch {
    // Distinguished so a slow site is never reported to the volunteer as
    // "they have no published address" -- that is a conclusion they would act on.
    return { data: null, timedOut: timer.aborted || Boolean(signal?.aborted), status: 0 };
  }
}

export interface ContactFind {
  email: string | null;
  // name/role are the best person we could evidence; `email` stays the top-level
  // field the card already reads, so an older client keeps working unchanged.
  name: string | null;
  role: string | null;
  sourceUrl: string | null;
  all: string[];
  people: ContactPerson[];
  checked: number;
  error: string | null;
}

/**
 * Find a published contact for one company: an address, and where the site
 * publishes one, the named person to send it to.
 *
 * Never throws: a failure returns email:null with a reason, because the card
 * showing "no published address found" is a fine outcome and an exception is
 * not.
 */
export async function findContactEmail(
  website: string,
  opts: { signal?: AbortSignal } = {}
): Promise<ContactFind> {
  const empty: ContactFind = {
    email: null,
    name: null,
    role: null,
    sourceUrl: null,
    all: [],
    people: [],
    checked: 0,
    error: null,
  };
  const host = hostOf(website);
  if (!host) return { ...empty, error: "This lead has no usable website." };
  if (isBannedHost(host))
    return { ...empty, error: "This lead's website is a social profile, not a company site." };
  if (!hasFirecrawlKey()) return { ...empty, error: "FIRECRAWL_API_KEY is not set." };

  let timedOut = false;
  // First API failure seen, so an empty result can say which it was. null means
  // every call answered -- distinct from 0, which is a call that never got one.
  // As a plain number the two were the same falsy value, so a DNS failure or a
  // dropped connection reported "no published address", the one conclusion a
  // volunteer acts on.
  let failCode: number | null = null;
  const note = (r: PostResult) => {
    timedOut = timedOut || r.timedOut;
    if (failCode === null && !r.timedOut && (r.status === 0 || r.status >= 400)) failCode = r.status;
    return r;
  };

  // 1. Map the site for contact-ish pages. Cheap, and its descriptions
  //    sometimes carry the address even when the page markdown does not.
  //
  //    Twice and in parallel: the page that publishes an address and the page
  //    that names a person are usually not the same page, and a search for
  //    "contact" returns few /team or /leadership URLs to rank. Two maps cost
  //    one extra credit and ~0s of wall clock; missing the team page costs the
  //    named contact, which is the only reason to run this at all.
  const maps = await Promise.all(
    ["contact", "team leadership about"].map((search) =>
      post("/map", { url: `https://${host}`, search }, opts.signal)
    )
  );
  maps.forEach(note);
  const links = maps.flatMap((m) =>
    Array.isArray(m.data?.links) ? (m.data.links as Record<string, unknown>[]) : []
  );

  // Keyed by address, and filled per link and per scraped page rather than from
  // one joined blob. A wrong citation is worse than none -- it is the one thing
  // a volunteer checks before hitting send -- and both shortcuts produced one:
  // the blob attributed every address to links[0].url, and a single "first page
  // that had any address" pointer cited /contact for a sponsorship@ that is
  // published on /about.
  //
  // An address in the map index no longer ends the search: a person is only
  // ever published on the page itself, so the scrapes below still run. It does
  // mean a site that hides its address behind a form can still yield one.
  const emailSource = new Map<string, string>();
  for (const l of links) {
    const text = [l.title, l.description].filter(Boolean).join(" ");
    if (!text) continue;
    const url = String(l.url ?? `https://${host}`);
    for (const e of companyEmails(text, host)) if (!emailSource.has(e)) emailSource.set(e, url);
  }

  // 2. Read the most contact-like pages on their own domain.
  const urls = rankUrls(
    [...new Set(links.map((l) => String(l.url ?? "")).filter(Boolean))],
    host
  );
  const targets = (
    urls.length ? urls : [`https://${host}/contact`, `https://${host}/about`, `https://${host}`]
  ).slice(0, 3);

  const people: ContactPerson[] = [];
  let checked = 0;
  for (const url of targets) {
    // Both halves in hand is enough: more pages only spend credits and the
    // volunteer's 25 seconds.
    if (people.length && emailSource.size) break;
    // onlyMainContent:false on purpose. Contact addresses live in the footer,
    // which "main content" extraction strips -- binnie.com/contact scraped to
    // 3770 chars with no email in it while the address was sitting in the
    // footer of the same page.
    const res = note(
      await post("/scrape", { url, formats: ["markdown"], onlyMainContent: false }, opts.signal)
    );
    checked++;
    const md = String((res.data?.data as Record<string, unknown> | undefined)?.markdown ?? "");
    if (!md) continue;
    // Addresses are read from any page; people only from the pages a company
    // publishes people on.
    if (isPeoplePage(url)) people.push(...extractPeople(md, host, url));
    for (const h of companyEmails(md, host)) if (!emailSource.has(h)) emailSource.set(h, url);
  }

  // 3. Nobody named yet? Ask Exa for pages on the same domain that /map never
  //    returned. /map walks the site's own link graph, so a bio linked only
  //    from a news post -- or not linked at all -- is invisible to it while
  //    sitting in Exa's index. Measured on 6 real leads: the companies Exa
  //    named a person for and the ones the crawl found an address for were
  //    disjoint sets.
  //
  //    includeDomains pins it to their own site. Off-domain results are where
  //    this goes wrong: a search for "<company> founder" happily returns a
  //    different company's founder from a directory page, and the extractor
  //    cannot tell that page is not theirs. On-domain keeps the evidence
  //    standard identical to the crawl's.
  //
  //    Skipped once the budget is already gone: exaSearch takes no AbortSignal,
  //    so starting it here is uncancellable and outlives the route's 30s cap,
  //    turning a reportable "search timed out" into a 504 the card can only
  //    render as "Search failed".
  if (!people.length && !opts.signal?.aborted) {
    try {
      if (hasExaKey()) {
        const hits = await exaSearch(`${baseName(host)} team leadership founder owner`, {
          numResults: 4,
          includeDomains: [host],
          textChars: 6000,
        });
        for (const h of hits) {
          // hostOf re-checks rather than trusting includeDomains: it is a
          // request parameter, and this is the guard that keeps a stranger's
          // name off the card.
          if (!h.text || hostOf(h.url) !== host || !isPeoplePage(h.url)) continue;
          people.push(...extractPeople(h.text, host, h.url));
        }
      }
    } catch {
      // Exa is the fallback's fallback. Its failure just means no named
      // person, which is already a supported outcome below.
    }
  }

  const all = [...emailSource.keys()];
  const ranked = rankPeople(people);
  const person = ranked[0] ?? null;
  // A timeout must not be reported as "they have no address" -- that is a
  // conclusion the volunteer would act on. Map alone has been measured at 1s
  // and at 17s on the same key, so running out of time is a normal outcome.
  // Tracked per call, not just from the caller's signal: a per-call timeout
  // fires without the outer signal ever aborting.
  const ranOut = !all.length && !ranked.length && (timedOut || Boolean(opts.signal?.aborted));

  // The person's own address beats the switchboard -- reaching the owner is the
  // whole reason for reading team pages. pickEmail only ever chooses between
  // company mailboxes, where a named desk really is the better target.
  const email = person?.email ?? pickEmail(all);
  return {
    email,
    name: person?.name ?? null,
    role: person?.role ?? null,
    // Still the page that evidenced the ADDRESS, unchanged: citing a page that
    // does not contain it is worse than citing nothing, and it is the one thing
    // a volunteer checks before hitting send. The person carries their own
    // page in people[].
    sourceUrl:
      person?.email && email === person.email
        ? person.sourceUrl
        : email
          ? (emailSource.get(email) ?? null)
          : null,
    all,
    people: ranked,
    checked,
    // A person with no address is still a result: the name and title are saved
    // on the lead, and the card's only channel for saying so is this line.
    error: email
      ? null
      : person
        ? `Found ${person.name} (${person.role}) — but no address published on their site.`
        : ranOut
          ? "Search timed out — their site was slow. Try again."
          : // "Nothing published" is a conclusion the volunteer acts on, so it is
            // only ever said when every call actually answered. A 429 comes back
            // in 200ms and used to be reported as an empty site.
            failCode === 429
            ? "Firecrawl rate limit reached — wait a minute and try again."
            : failCode !== null
              ? `Their site could not be read (Firecrawl ${failCode || "no response"}). Try again.`
              : "No published address found on their site.",
  };
}
