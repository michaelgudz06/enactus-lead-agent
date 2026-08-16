// The logo tile on a lead card, as two pure functions so LeadCard stays JSX and
// scripts/selfcheck.ts can pin them.
//
// No imports on purpose: firecrawl.ts exports the same hostOf(), but it is 685
// lines of server code and LeadCard is a client component. selfcheck pins this
// copy against the original.

// Social and aggregator profiles are never a logo source. lead.website is
// model-written and stored unvalidated, so this is the
// standing "never link LinkedIn" rule enforced where the request is actually
// made, not in a prompt. Dot-anchored, so linkedinsurance.com is a real company.
const SOCIAL = /(^|\.)(linkedin|facebook|instagram|twitter|x|youtube|tiktok|yelp|crunchbase|indeed|glassdoor)\./;

/**
 * Favicon URL for a lead's OWN domain, or null -- the caller renders monogram().
 * sz=128 is a crisp 32px tile at 2x; sz=256 cost 10x the bytes for 1.4x pixels.
 *
 * Never derive this from lead.sources[0].url -- that is the page the candidate
 * was FOUND on, frequently a publisher's ("Renaissance Coffee" on sfu.ca), so it
 * would print the newspaper's mark on the company's card.
 */
export function logoUrl(website: string | null | undefined): string | null {
  if (!website) return null;
  // The website column is stored unvalidated, so the value
  // arrives however the model wrote it: padded, or upper-case scheme.
  const raw = website.trim();
  let host: string;
  try {
    // URL() also normalises the hostname, which is what makes it safe to
    // interpolate into a query string without escaping.
    host = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
  if (!host.includes(".") || SOCIAL.test(host)) return null;
  return `https://www.google.com/s2/favicons?domain=${host}&sz=128`;
}

/** Fallback tile letter -- a primary state on ~29% of cards, not an error one. */
export function monogram(company: string): string {
  return company.replace(/^the\s+/i, "").trim()[0]?.toUpperCase() ?? "?";
}
