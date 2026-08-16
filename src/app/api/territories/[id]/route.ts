import { route } from "@/lib/auth";
import { db } from "@/lib/db";
import { Territory } from "@/lib/geocode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(async (session, req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const swept = b.swept !== false;
  const sweptAt = swept ? new Date().toISOString() : null;
  const sweptBy = swept ? session.name : null;

  // lead_count is recomputed here rather than sent by the client, so the
  // number on a swept territory is always what the map is actually showing.
  // Haversine inline because this database has no PostGIS; least/greatest
  // clamp the acos argument, which float drift can otherwise push past 1 and
  // turn into a domain error mid-sweep.
  const rows = (await db()`
    update enactus_territories as t
    set swept_at = ${sweptAt},
        swept_by_name = ${sweptBy},
        lead_count = (
          select count(*) from enactus_leads l
          where l.lat is not null and l.lng is not null
            and 6371000 * acos(least(1, greatest(-1,
                  sin(radians(t.lat)) * sin(radians(l.lat))
                + cos(radians(t.lat)) * cos(radians(l.lat)) * cos(radians(l.lng - t.lng))
            ))) <= t.radius_m
        )
    where t.id = ${id}
    returning *`) as unknown as Territory[];

  if (!rows.length) return Response.json({ error: "Territory not found" }, { status: 404 });
  return Response.json({ territory: rows[0] });
});
