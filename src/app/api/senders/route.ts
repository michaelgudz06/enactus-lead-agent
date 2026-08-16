import { route } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const senders = await db()`select * from enactus_senders order by name asc`;
  return Response.json({ senders });
}, { senders: [] });

export const POST = route(async (session, req: Request) => {
  const b = await req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim();
  const email = String(b.email ?? "").trim();
  // Unlike a lead, a sender has no useful placeholder value: it is the identity
  // an email is sent AS, so a blank one is a send failure deferred to later.
  if (!name || !email.includes("@")) {
    return Response.json({ error: "A name and an email address are required." }, { status: 400 });
  }

  const [sender] = await db()`
    insert into enactus_senders (name, email, title, signature, created_by_name)
    values (${name}, ${email}, ${b.title ?? null}, ${b.signature ?? null}, ${session.name})
    returning *`;
  return Response.json({ sender });
});
