import { route } from "@/lib/auth";
import { db, setClause } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EDITABLE = new Set(["name", "email", "title", "signature"]);

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route(async (_session, req: Request, { params }: Ctx) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  // Editing is the path every sender actually takes after creation, so the
  // check POST makes has to hold here too -- otherwise clearing the field in
  // the form saves a sender that can never send, and the UI reports "Saved".
  if (("name" in b && !String(b.name ?? "").trim()) || ("email" in b && !String(b.email ?? "").includes("@"))) {
    return Response.json({ error: "A name and an email address are required." }, { status: 400 });
  }

  const { sets, values } = setClause(b, EDITABLE);
  values.push(id);
  const rows = await db().query(
    `update enactus_senders set ${sets.join(", ")} where id = $${values.length} returning *`,
    values
  );
  if (!rows.length) return Response.json({ error: "Sender not found" }, { status: 404 });
  return Response.json({ sender: rows[0] });
});

export const DELETE = route(async (_session, _req: Request, { params }: Ctx) => {
  const { id } = await params;
  await db()`delete from enactus_senders where id = ${id}`;
  return Response.json({ ok: true });
});
