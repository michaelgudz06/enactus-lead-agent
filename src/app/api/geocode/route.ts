import { route } from "@/lib/auth";
import { db } from "@/lib/db";
import { classifyLocation, geocode } from "@/lib/geocode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Nominatim allows one request a second, so a full 206-lead backfill cannot fit
// in a single function call. The UI calls this repeatedly and watches
// `remaining` instead, which also means a timeout costs one batch rather than
// the whole run.
const BATCH = 40;

export const POST = route(async (_session, req: Request) => {
  const b = await req.json().catch(() => ({}));
  const sql = db();

  // Clearing the stamp is the whole of `force`: the batch below then treats
  // every located lead as new work, and later calls drain it normally.
  if (b.force) await sql`update enactus_leads set geocoded_at = null where location is not null`;

  const batch = (await sql`
    select id, location from enactus_leads
    where location is not null and geocoded_at is null
    order by created_at asc
    limit ${BATCH}`) as { id: string; location: string }[];

  // 146 of the 198 located leads are cities, and they collapse to ~13 distinct
  // queries. Asking Nominatim once per lead would burn the whole 60s on
  // "Vancouver, BC, Canada" eleven times over.
  const seen = new Map<string, { lat: number; lng: number } | null>();
  let placed = 0;

  for (const lead of batch) {
    const { precision, query } = classifyLocation(lead.location);
    let point: { lat: number; lng: number } | null = null;
    if (query) {
      if (!seen.has(query)) seen.set(query, await geocode(query));
      point = seen.get(query) ?? null;
    }
    if (point) placed++;

    // geocoded_at is stamped even when nothing was found, so an unplaceable
    // lead is asked about once and then stays out of the queue forever.
    await sql`
      update enactus_leads
      set lat = ${point?.lat ?? null}, lng = ${point?.lng ?? null},
          geo_precision = ${precision}, geocoded_at = now()
      where id = ${lead.id}`;
  }

  const [{ n }] = (await sql`
    select count(*)::int as n from enactus_leads
    where location is not null and geocoded_at is null`) as { n: number }[];

  return Response.json({ done: batch.length, placed, remaining: n });
});
