import { route } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const templates = await db()`
    select * from enactus_email_templates order by is_default desc, name asc`;
  return Response.json({ templates });
}, { templates: [] });

export const POST = route(async (session, req: Request) => {
  const b = await req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim();
  if (!name) return Response.json({ error: "A template name is required." }, { status: 400 });
  const isDefault = b.is_default === true;

  // The demotion rides along as a data-modifying CTE so "exactly one default"
  // holds inside one statement -- Postgres runs a WITH sub-statement to
  // completion whether or not the main query reads it. Two round trips would
  // leave a window where zero or two templates are the default.
  const [template] = await db()`
    with cleared as (
      update enactus_email_templates set is_default = false
      where ${isDefault}::boolean and is_default
    )
    insert into enactus_email_templates (name, subject, body, sender_id, is_default, created_by_name)
    values (
      ${name},
      ${b.subject ?? null},
      ${b.body ?? null},
      ${b.sender_id || null},
      ${isDefault}::boolean,
      ${session.name}
    )
    returning *`;
  return Response.json({ template });
});
