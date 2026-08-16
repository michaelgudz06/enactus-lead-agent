// Minimal Exa client for lead discovery + research.
// Docs: https://docs.exa.ai — POST /search with inline contents.

const EXA_URL = "https://api.exa.ai/search";

export interface ExaResult {
  url: string;
  title: string | null;
  publishedDate: string | null;
  author: string | null;
  text: string | null;
  highlights: string[];
}

export function hasExaKey() {
  const k = process.env.EXA_API_KEY;
  return Boolean(k && !k.startsWith("REPLACE"));
}

export async function exaSearch(
  query: string,
  opts: {
    numResults?: number;
    category?: string;
    excludeDomains?: string[];
    includeDomains?: string[];
    textChars?: number;
  } = {}
): Promise<ExaResult[]> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("EXA_API_KEY not set");

  const body: Record<string, unknown> = {
    query,
    numResults: opts.numResults ?? 8,
    type: "auto",
    contents: {
      // 1200 is plenty to judge a company from a search snippet, but a team
      // page lists people far below the fold and gets truncated mid-roster.
      // Callers reading people ask for more.
      text: { maxCharacters: opts.textChars ?? 1200 },
      highlights: { numSentences: 3, highlightsPerUrl: 2, query },
    },
  };
  if (opts.category) body.category = opts.category;
  // Pins the search to one company's own domain. The people extractor treats
  // "published on their site" as the evidence standard, so a search that can
  // wander off-domain would hand it pages it is not entitled to trust.
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;
  // Ask for pages we have never seen instead of paying for pages the
  // already-on-board filter is about to delete. That filter is correct -- it
  // stops two volunteers emailing the same cafe -- but it runs AFTER discovery,
  // so as the board grows the search keeps returning the same top-ranked
  // domains and the filter keeps deleting them, and the run starves. Exa caps
  // this list at 1000.
  if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains.slice(0, 1000);

  const res = await fetch(EXA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Exa ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = (await res.json()) as { results?: unknown[] };
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((r) => {
    const x = r as Record<string, unknown>;
    return {
      url: String(x.url ?? ""),
      title: (x.title as string) ?? null,
      publishedDate: (x.publishedDate as string) ?? null,
      author: (x.author as string) ?? null,
      text: (x.text as string) ?? null,
      highlights: Array.isArray(x.highlights) ? (x.highlights as string[]) : [],
    };
  });
}

// De-dupe by hostname so we don't research the same company twice.
export function dedupeByDomain(results: ExaResult[]): ExaResult[] {
  const seen = new Set<string>();
  const out: ExaResult[] = [];
  for (const r of results) {
    let host = "";
    try {
      host = new URL(r.url).hostname.replace(/^www\./, "");
    } catch {
      host = r.url;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(r);
  }
  return out;
}
