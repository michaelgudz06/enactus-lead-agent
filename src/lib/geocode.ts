// Turning the `location` column into map pins.
//
// That column is free text an LLM wrote, and it is far messier than "City, BC":
// 198 non-null values, 80 distinct, including "Burnaby, BC (based on context of
// supporting Burnaby Pride)", "Global (Swiss HQ)" and four full street
// addresses. A geocoder handed those raw either misses or -- much worse --
// silently resolves a country-level string to a centroid, which would drop
// "Global (Swiss HQ)" into the Lower Mainland as though it were a local sponsor.
//
// So precision is decided here, in code, before anything is geocoded, and only
// 'address' and 'city' are ever pinned. Everything else is shown as unplaceable
// rather than guessed at. Kept dependency-free so it can be unit-checked on its
// own: see scripts/selfcheck.ts.

export type GeoPrecision = "address" | "city" | "region" | "none";

// Known limit: move to src/lib/types.ts once the territories migration lands.
export interface Territory {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  swept_at: string | null;
  swept_by_name: string | null;
  lead_count: number;
}

// Name -> province, because the province is what disambiguates the geocoder
// query ("Langley, BC" and "Langley Township, ON" are different places) and a
// hardcoded "BC" would send Toronto and Montreal to the wrong coast.
//
// Lower Mainland first, then every out-of-region municipality that actually
// appears in the column. A name missing from this map classifies as 'region'
// and lands in the unplaceable list -- visibly absent beats silently mis-pinned.
// Known limit: hand-maintained list; swap for a gazetteer if the club expands
// outreach past BC.
const MUNICIPALITIES: Record<string, string> = {
  vancouver: "BC", burnaby: "BC", surrey: "BC", richmond: "BC", coquitlam: "BC",
  "port coquitlam": "BC", "port moody": "BC", "new westminster": "BC",
  "north vancouver": "BC", "west vancouver": "BC", delta: "BC", langley: "BC",
  "maple ridge": "BC", "pitt meadows": "BC", "white rock": "BC", abbotsford: "BC",
  mission: "BC", chilliwack: "BC", aldergrove: "BC", tsawwassen: "BC",
  ladner: "BC", cloverdale: "BC", "bowen island": "BC", "lions bay": "BC",
  anmore: "BC", belcarra: "BC", squamish: "BC", whistler: "BC",
  victoria: "BC", nanaimo: "BC", kelowna: "BC", kamloops: "BC", "prince george": "BC",
  calgary: "AB", edmonton: "AB", toronto: "ON", ottawa: "ON", brampton: "ON",
  mississauga: "ON", oakville: "ON", montreal: "QC", winnipeg: "MB",
  halifax: "NS", stellarton: "NS",
};

// Phrases that contain a municipality name but are not that municipality.
// "Greater Vancouver" is a region of 2.6M people; pinning it on Vancouver's
// city hall is the exact lie this module exists to prevent. Removed from the
// string before the municipality scan runs, longest first so "Metro Vancouver"
// is consumed before a bare "Vancouver" can match inside it.
const REGION_PHRASES = [
  "greater vancouver", "metro vancouver", "vancouver island", "lower mainland",
  "fraser valley", "pacific northwest", "north shore", "tri cities", "okanagan",
];

// Evidence that a string names *somewhere*, just not somewhere pinnable. Splits
// the unplaceable rows into an honest 'region' ("Canada-wide") versus 'none'
// (nothing recognisable at all), which is what the map's side panel reports.
const REGION_TOKENS = [
  "bc", "british columbia", "canada", "alberta", "ontario", "quebec", "manitoba",
  "saskatchewan", "nova scotia", "new brunswick", "newfoundland", "yukon",
  "global", "international", "national", "worldwide", "western canada", "coastal",
];

/**
 * Collapse one raw `location` value to the part that could plausibly be
 * geocoded. Everything from the first "(" is dropped: 41 of the 198 rows carry
 * a parenthetical, and every one of them is commentary about the location
 * rather than more of it -- "(Headquarters)", "(based on context of supporting
 * Burnaby Pride)", "(Likely BC, based on 604 phone number)". Dropping it early
 * is also what makes the municipality scan below safe, since it removes the
 * stray city names hiding inside asides like "Canada (Headquarters in
 * Vancouver, BC)".
 */
export function normalizeLocation(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // Montreal/Montréal must be one spelling to match
    .split("(")[0]
    .replace(/\bB\.\s*C\.?/gi, "BC")
    .replace(/\bBritish Columbia\b/gi, "BC")
    .replace(/,\s*Canada\s*$/i, "") // trailing country adds nothing a geocoder needs
    .replace(/\s+/g, " ")
    .replace(/[\s,;/&-]+$/, "")
    .trim();
}

/**
 * Decide how precisely a location is known, and what to actually ask the
 * geocoder. `query` is null whenever the answer is "do not pin this".
 *
 * A city resolves to a canonical "City, PROV, Canada" rather than the raw text
 * because the raw text is where the noise is: "Metrotown, Burnaby & Greater
 * Vancouver" geocodes badly, "Burnaby, BC, Canada" does not.
 */
export function classifyLocation(raw: string | null | undefined): {
  precision: GeoPrecision;
  query: string | null;
} {
  const norm = normalizeLocation(raw);
  if (!norm) return { precision: "none", query: null };

  // A leading street number is the only reliable signal of a street address in
  // this data, and all four real ones have it ("7442 Fraser Park Drive, ...").
  if (/^\d/.test(norm)) return { precision: "address", query: norm };

  // Hyphens split too, or "Canada-wide" hides its own country token and a
  // national chain reads as unclassifiable instead of merely unpinnable.
  const hay = ` ${norm.toLowerCase().replace(/[.,;/&-]/g, " ").replace(/\s+/g, " ")} `;

  let scan = hay;
  let sawRegionPhrase = false;
  for (const phrase of [...REGION_PHRASES].sort((a, b) => b.length - a.length)) {
    if (scan.includes(` ${phrase} `)) {
      sawRegionPhrase = true;
      scan = scan.replaceAll(` ${phrase} `, " ");
    }
  }

  // Longest name first: "North Vancouver" must win over the "Vancouver" inside
  // it, or every North Van lead pins downtown.
  const names = Object.keys(MUNICIPALITIES).sort((a, b) => b.length - a.length);
  const hit = names.find((n) => scan.includes(` ${n} `));
  if (hit) return { precision: "city", query: `${title(hit)}, ${MUNICIPALITIES[hit]}, Canada` };

  const regional = sawRegionPhrase || REGION_TOKENS.some((t) => hay.includes(` ${t} `));
  return { precision: regional ? "region" : "none", query: null };
}

function title(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Nominatim's usage policy is one request per second and a User-Agent that
// identifies the app; ignoring either gets the whole IP blocked, which on
// Vercel is an IP we share. The gate is here rather than in the calling route
// so no future caller can forget it. It only spans a single function instance,
// which is enough because the one caller batches its work into one invocation.
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "EnactusSFU-LeadAgent/1.0 (https://enactus-agent-mocha.vercel.app)";
let lastRequestAt = 0;

async function throttle() {
  const wait = 1100 - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * One free-text lookup against OpenStreetMap. No key, no cost, no quota beyond
 * the rate limit.
 *
 * Never throws: geocoding is decoration on a lead that is already useful, so an
 * outage has to leave the pin missing rather than fail the whole backfill.
 */
export async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  try {
    await throttle();
    const url = `${NOMINATIM}?format=json&countrycodes=ca&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, cache: "no-store" });
    if (!res.ok) return null;
    const hits = (await res.json()) as { lat?: string; lon?: string }[];
    const hit = Array.isArray(hits) ? hits[0] : null;
    if (!hit?.lat || !hit?.lon) return null;
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}
