import { route } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_session, req: Request) => {
  const mode = new URL(req.url).searchParams.get("mode");
  const sql = db();
  // last_activity_at is derived, not stored: the newest of the row's own
  // updated_at and its newest timeline entry. Computing it here rather than
  // keeping a column means no write path has to remember to touch it, and
  // Postgres GREATEST already ignores the null from a lead with no activity.
  // It is what the follow-up chips measure silence against.
  const leads =
    mode === "sponsor" || mode === "sales"
      ? await sql`select l.*, greatest(l.updated_at,
                    (select max(a.created_at) from enactus_lead_activity a where a.lead_id = l.id)
                  ) as last_activity_at
                  from enactus_leads l where l.mode = ${mode}
                  order by l.board_order asc, l.created_at desc`
      : await sql`select l.*, greatest(l.updated_at,
                    (select max(a.created_at) from enactus_lead_activity a where a.lead_id = l.id)
                  ) as last_activity_at
                  from enactus_leads l
                  order by l.board_order asc, l.created_at desc`;
  return Response.json({ leads });
}, { leads: [] });
