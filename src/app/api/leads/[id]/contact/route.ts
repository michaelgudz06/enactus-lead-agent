import { route } from "@/lib/auth";
import { findContactFor } from "@/lib/contact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// On demand, one lead at a time: a map + up to two scrapes runs 3-12s, which
// does not fit in the agent's 60s budget and would burn credits on leads nobody
// emails. Kept out of the run on purpose. The same lookup also fires
// automatically when a lead is dragged out of prospects -- see the PATCH route.
export const POST = route(async (session, _req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const found = await findContactFor(id, session.name);
  if ("error" in found && found.error === "Lead not found")
    return Response.json({ error: "Lead not found" }, { status: 404 });
  return Response.json(found);
});
