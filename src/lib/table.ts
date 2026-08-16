// Filtering, sorting and faceting for the list view.
//
// The board answers "what is moving"; the list answers "where is X" and "how
// many of these do we have". That means the logic here is the whole feature --
// the page is a table around it -- so it lives outside the component and gets
// pinned in scripts/selfcheck.ts.
//
// No imports on purpose: selfcheck runs this file under
// `node --experimental-strip-types`, which cannot resolve extensionless
// specifiers. Anything this needs from elsewhere (the pipeline order, whether a
// lead is overdue) arrives as an argument. Same shape as every other
// selfcheck-tested lib here.

export type EmailFilter = "any" | "has" | "missing";

export interface LeadFilters {
  q?: string;
  /** Empty array means "no filter", never "match nothing". */
  status?: string[];
  /** personKey() values. "" selects the rows with nobody on them. */
  owner?: string[];
  createdBy?: string[];
  industry?: string[];
  email?: EmailFilter;
  /** Only rows the caller's isDue() says are overdue. */
  due?: boolean;
}

type Row = Record<string, unknown>;

// The constraint is `object`, not Record<string, unknown>: an interface such as
// Lead has no implicit index signature, so constraining to a record makes TS
// widen T to the record and every caller loses its own type on the way out.
// Reading through here keeps the generic transparent at the call site.
const get = (row: object, key: string): unknown => (row as Row)[key];

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/**
 * The identity of a person as a filter key. Case- and space-insensitive because
 * the name is whatever was typed at the login box: this board holds 79 leads
 * added by "Michael" and 31 by "michael", which is one volunteer and would
 * otherwise be two rows in every dropdown and two buckets in every count.
 */
export function personKey(name: unknown): string {
  return str(name).trim().toLowerCase();
}

// Every field a volunteer might type into the search box. Deliberately includes
// the long-form ones (description, why_fit, reasoning): "who was the bakery in
// Richmond" is a real question and the answer is only in the prose.
const SEARCH_FIELDS = [
  "company", "industry", "location", "contact_name", "contact_role",
  "contact_email", "website", "owner_name", "created_by_name",
  "why_fit", "description", "reasoning", "connection_note",
];

export function matchesQuery(row: object, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  // Every word has to appear somewhere, in any field and any order: "purdys
  // chocolate" and "chocolate purdys" are the same question. A single joined
  // haystack rather than per-field matching, so a query can span two columns.
  const hay = SEARCH_FIELDS.map((f) => str(get(row, f))).join(" ").toLowerCase();
  return needle.split(/\s+/).every((w) => hay.includes(w));
}

/**
 * `isDue` is injected rather than imported: next-action.ts owns that rule and
 * needs a clock, and this file has neither imports nor a right to read one.
 */
export function filterLeads<T extends object>(
  rows: T[],
  f: LeadFilters,
  isDue?: (row: T) => boolean
): T[] {
  // An empty selection means the filter is off. Getting this backwards is the
  // classic version of this bug: clearing the last checkbox empties the table
  // and reads as "we have no leads".
  const on = (sel: string[] | undefined) => Array.isArray(sel) && sel.length > 0;

  return rows.filter((r) => {
    if (!matchesQuery(r, f.q ?? "")) return false;
    if (on(f.status) && !f.status!.includes(str(get(r, "status")))) return false;
    if (on(f.owner) && !f.owner!.includes(personKey(get(r, "owner_name")))) return false;
    if (on(f.createdBy) && !f.createdBy!.includes(personKey(get(r, "created_by_name")))) return false;
    // Word match, not value match -- see industryFacets for why.
    if (on(f.industry) && !f.industry!.some((w) => industryMatches(r, w))) return false;

    if (f.email === "has" && !str(get(r, "contact_email")).includes("@")) return false;
    // Not `=== ""`: a row can carry a value that is not a usable address, and
    // "missing" has to mean "nothing to send to" or the filter lies about the
    // work left.
    if (f.email === "missing" && str(get(r, "contact_email")).includes("@")) return false;

    if (f.due && !(isDue?.(r) ?? false)) return false;
    return true;
  });
}

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v));

/**
 * Sort one column. `order` maps a value to a rank, which is how status sorts
 * down the pipeline instead of alphabetically ("Closed / Won" before
 * "Prospects" is not a sort anyone asked for).
 *
 * Blanks always sort last, in BOTH directions. Reversing a column should bring
 * the other end of the real data into view, not 27 empty cells -- and on this
 * board the empty cells are the majority for half the columns (101 of 110 rows
 * have no email, 106 no contact name).
 */
export function sortLeads<T extends object>(
  rows: T[],
  key: string,
  dir: 1 | -1,
  order?: Record<string, number>
): T[] {
  const rank = (v: unknown) => (order ? order[str(v)] ?? Number.MAX_SAFE_INTEGER : undefined);

  return [...rows].sort((x, y) => {
    const a = get(x, key);
    const b = get(y, key);
    const ab = isBlank(a);
    const bb = isBlank(b);
    if (ab && bb) return 0;
    if (ab) return 1;
    if (bb) return -1;

    if (order) return dir * (rank(a)! - rank(b)!);
    if (typeof a === "number" && typeof b === "number") return dir * (a - b);
    // numeric collation so "$900" sorts under "$1,200" and a name with a digit
    // in it behaves. ISO timestamps compare correctly under it too, since each
    // digit run is compared in place.
    return dir * str(a).localeCompare(str(b), undefined, { numeric: true, sensitivity: "base" });
  });
}

// Words that carry no filtering signal once industry strings are chopped up.
// "Services" appears in a dozen unrelated industries; "and" in half of them.
const INDUSTRY_STOPWORDS = new Set([
  "and", "or", "the", "of", "for", "a", "an", "amp",
  "services", "service", "solutions", "products", "product", "management",
  "company", "companies", "general", "other", "misc", "inc", "ltd",
]);

/**
 * Industry as a set of WORDS, not whole strings.
 *
 * `industry` is free text written by the model, so 149 leads produced ~100
 * distinct values -- coffee alone was five separate options ("Coffee", "Coffee
 * Roaster", "Coffee Roaster & Retail", "Coffee Roasting / Social Enterprise",
 * "Coffee Roasting & Chocolate (Social Enterprise)"). A dropdown of ninety
 * singletons is a list, not a filter. Splitting on punctuation and counting
 * words collapses those five into one "Coffee (5)" that actually selects them
 * all, and the matching side (industryMatches) is substring-on-word to suit.
 *
 * Normalising the values themselves would need a taxonomy nobody here is going
 * to maintain, and would throw away the model's specificity in the column.
 */
export function industryFacets<T extends object>(rows: T[], min = 2): Facet[] {
  const counts = new Map<string, { label: string; count: number }>();

  for (const r of rows) {
    const raw = str(get(r, "industry"));
    // Each row votes for a word at most once: "Food Products (Organic) / Food
    // Manufacturing" must not count Food twice and outrank a word in 3 rows.
    const seen = new Set<string>();
    for (const w of raw.split(/[^\p{L}\p{N}]+/u)) {
      const key = w.toLowerCase();
      if (key.length < 3 || INDUSTRY_STOPWORDS.has(key) || seen.has(key)) continue;
      seen.add(key);
      const g = counts.get(key);
      if (g) g.count++;
      else counts.set(key, { label: w, count: 1 });
    }
  }

  return [...counts.entries()]
    .filter(([, g]) => g.count >= min)
    .map(([key, g]) => ({ key, label: g.label, count: g.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** True when the row's industry text contains this whole word. */
export function industryMatches(row: object, word: string): boolean {
  if (!word) return true;
  return str(get(row, "industry"))
    .split(/[^\p{L}\p{N}]+/u)
    .some((w) => w.toLowerCase() === word);
}

export interface Facet {
  /** The filter value — normalised, so it matches what filterLeads compares. */
  key: string;
  /** The spelling to show: whichever original form is most common. */
  label: string;
  count: number;
}

/**
 * Distinct values of one column, for a dropdown. Grouped by personKey so
 * "Michael" and "michael" are one entry, and labelled with the majority
 * spelling rather than whichever happened to be seen first.
 *
 * `blankLabel` names the empty bucket -- unowned leads are the most useful
 * filter on this board, so it has to be selectable rather than dropped.
 */
export function facets<T extends object>(rows: T[], field: string, blankLabel = "—"): Facet[] {
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>();

  for (const r of rows) {
    const raw = str(get(r, field)).trim();
    const key = personKey(raw);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { count: 0, spellings: new Map() }));
    g.count++;
    if (raw) g.spellings.set(raw, (g.spellings.get(raw) ?? 0) + 1);
  }

  return [...groups.entries()]
    .map(([key, g]) => {
      let label = blankLabel;
      let best = 0;
      for (const [spelling, n] of g.spellings) {
        // > not >=, so the first-seen spelling wins a tie and the order is
        // stable across reloads.
        if (n > best) { best = n; label = spelling; }
      }
      return { key, label, count: g.count };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
