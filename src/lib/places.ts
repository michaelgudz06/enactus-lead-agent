// Google Places API (New) — Text Search.
//
// Why this exists alongside Exa: Exa searches a web INDEX, so a query like
// "coffee shops near SFU" returns articles, listicles and directory pages
// ABOUT businesses. Places returns the businesses themselves, each with a real
// website and address, filtered to a radius around campus. For the
// local-sponsor half of the club's outreach that is a straight upgrade.
//
// Entirely optional: with no GOOGLE_PLACES_API_KEY set, hasPlacesKey() is
// false and the agent simply runs Exa-only exactly as before.

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

// SFU Burnaby campus. Sponsor outreach is overwhelmingly local to it.
export const SFU_BURNABY = { latitude: 49.2781, longitude: -122.9199 };

export interface PlaceResult {
  name: string;
  website: string | null;
  address: string | null;
  primaryType: string | null;
}

export function hasPlacesKey(): boolean {
  const k = process.env.GOOGLE_PLACES_API_KEY;
  return Boolean(k && !k.startsWith("REPLACE"));
}

/**
 * Text search around a point. Returns only businesses that publish a website,
 * because a lead with no site is not researchable or contactable downstream.
 *
 * Never throws: discovery is additive, so a Places outage must degrade the run
 * to Exa-only rather than fail it.
 */
export async function placesSearch(
  query: string,
  opts: { maxResults?: number; radiusMeters?: number; signal?: AbortSignal } = {}
): Promise<PlaceResult[]> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        // The field mask decides the SKU, not just the payload. Phone numbers
        // are an Enterprise-tier field, and asking for one billed EVERY search
        // at Enterprise (1,000 free calls/month instead of the Pro tier's
        // 5,000) -- for a value this app never stores and only ever pasted into
        // a text blob for the model. websiteUri stays: it is a Pro field and
        // the whole point of a Places result here is getting a domain to
        // research, so dropping it would make the source useless.
        "X-Goog-FieldMask": [
          "places.displayName",
          "places.websiteUri",
          "places.formattedAddress",
          "places.primaryType",
          "places.businessStatus",
        ].join(","),
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: Math.min(20, Math.max(1, opts.maxResults ?? 10)),
        regionCode: "CA",
        locationBias: {
          circle: { center: SFU_BURNABY, radius: opts.radiusMeters ?? 15000 },
        },
      }),
      signal: opts.signal,
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { places?: Record<string, unknown>[] };
    return (data.places ?? [])
      .filter((p) => p.businessStatus === "OPERATIONAL" && typeof p.websiteUri === "string")
      .map((p) => ({
        name: String((p.displayName as { text?: string })?.text ?? ""),
        website: (p.websiteUri as string) ?? null,
        address: (p.formattedAddress as string) ?? null,
        primaryType: (p.primaryType as string) ?? null,
      }))
      .filter((p) => p.name);
  } catch {
    return [];
  }
}
