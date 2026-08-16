import { route } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// status_change and contact_found are written by other routes, never by a
// client, so the composer can only ever post the three human kinds.
const KINDS = new Set(["note", "call", "email"]);

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_session, _req: Request, { params }: Ctx) => {
  const { id } = await params;
  const activities = await db()`
    select * from enactus_lead_activity where lead_id = ${id}
    order by created_at desc`;
  return Response.json({ activities });
});

export const POST = route(async (session, req: Request, { params }: Ctx) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const kind = KINDS.has(b?.kind) ? (b.kind as string) : "note";
  // Capped the way the draft route caps copy: a textarea will happily post a
  // megabyte, and nothing downstream reads past a paragraph.
  const body = String(b?.body ?? "").trim().slice(0, 4000);
  if (!body) return Response.json({ error: "body required" }, { status: 400 });

  // actor_name is read off the signed session cookie and never off the body:
  // the whole point of the log is who touched this sponsor, so it must not be
  // something a caller can claim. meta is left to its default for the same
  // reason -- only the routes that write system rows have anything true to
  // put in it, so there is no client-supplied jsonb to store or trust.
  const [activity] = await db()`
    insert into enactus_lead_activity (lead_id, kind, body, actor_name)
    values (${id}, ${kind}, ${body}, ${session.name})
    returning *`;
  return Response.json({ activity });
});
