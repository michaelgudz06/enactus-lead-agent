import { route } from "@/lib/auth";
import { db, setClause } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EDITABLE = new Set(["name", "subject", "body", "sender_id", "is_default"]);

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route(async (_session, req: Request, { params }: Ctx) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  if ("name" in b && !String(b.name ?? "").trim()) {
    return Response.json({ error: "A template name is required." }, { status: 400 });
  }
  // Normalised before the allow-list runs: an unset picker posts "" and the
  // checkbox posts whatever the form had, neither of which the column accepts.
  if ("is_default" in b) b.is_default = b.is_default === true;
  if ("sender_id" in b) b.sender_id = b.sender_id || null;

  const { sets, values } = setClause(b, EDITABLE, { is_default: "::boolean" });
  values.push(id);
  const idParam = `$${values.length}`;
  values.push(b.is_default === true);
  const promotingParam = `$${values.length}`;

  // Demote the others in the same statement as the promotion, so the board
  // never sees two defaults. The two updates touch disjoint rows (id <> vs
  // id =), which is what keeps a single statement from updating a row twice.
  const rows = await db().query(
    `with cleared as (
       update enactus_email_templates set is_default = false
       where ${promotingParam}::boolean and is_default and id <> ${idParam}
     )
     update enactus_email_templates set ${sets.join(", ")} where id = ${idParam} returning *`,
    values
  );
  if (!rows.length) return Response.json({ error: "Template not found" }, { status: 404 });
  return Response.json({ template: rows[0] });
});

export const DELETE = route(async (_session, _req: Request, { params }: Ctx) => {
  const { id } = await params;
  await db()`delete from enactus_email_templates where id = ${id}`;
  return Response.json({ ok: true });
});
