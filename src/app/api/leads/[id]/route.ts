import { after } from "next/server";
import { route } from "@/lib/auth";
import { db, setClause } from "@/lib/db";
import { findContactFor } from "@/lib/contact";
import { STATUS_COLUMNS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The drag returns immediately; the contact lookup that follows it runs in
// after() and needs the headroom of a scrape, not of a single UPDATE.
export const maxDuration = 30;

const EDITABLE = new Set([
  "company", "website", "industry", "description", "contact_name", "contact_role",
  "contact_email", "location", "connection_type", "connection_note", "sponsorship_type",
  "why_fit", "status", "board_order", "amount", "owner_name",
]);

// closed_at and owner_name are deliberately absent from EDITABLE above: both are
// stamped by this route from the stage move and the session, never accepted from
// a request body. owner_name is the one exception -- the Claim button sets it
// explicitly -- which is why it appears there but closed_at does not.
const CLOSED = new Set(["closed_won", "closed_lost"]);

// setClause only decides WHICH columns may be written, never what may go in
// them, so status took any string at all. The board renders a lead by looking
// its status up in a column map and falling back to prospects, so an unknown
// value does not error -- it files the lead under Prospects and leaves no way
// to move it back. The activity log already carries two rows written with a
// status of "contacted", which is not in the union.
const STATUSES = new Set<string>(STATUS_COLUMNS.map((c) => c.id));

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route(async (session, req: Request, { params }: Ctx) => {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  if ("status" in b && !STATUSES.has(b.status)) {
    return Response.json({ error: `Unknown status "${b.status}"` }, { status: 400 });
  }
  // The board sends whatever prompt() returned, so this is a trust boundary:
  // null clears the amount, anything that is not a whole non-negative number of
  // dollars is a typo and must not reach a column the totals are summed from.
  if ("amount" in b && b.amount !== null && !(Number.isInteger(b.amount) && b.amount >= 0)) {
    return Response.json(
      { error: "amount must be a whole number of dollars, or null" },
      { status: 400 }
    );
  }
  const { sets, values } = setClause(b, EDITABLE, { sponsorship_type: "::text[]" });
  values.push(id);

  // "from" is only knowable before the write, and only worth a round-trip
  // when this patch actually carries a status.
  const from = "status" in b
    ? (await db()`select status from enactus_leads where id = ${id}`)[0]?.status
    : undefined;

  const rows = await db().query(
    `update enactus_leads set ${sets.join(", ")} where id = $${values.length} returning *`,
    values
  );
  if (!rows.length) return Response.json({ error: "Lead not found" }, { status: 404 });

  if (from !== undefined && from !== rows[0].status) {
    // The move is the user's action and has already committed. Losing its
    // timeline entry is worth a log line, never a failed drag.
    try {
      await db()`
        insert into enactus_lead_activity (lead_id, kind, meta, actor_name)
        values (${id}, 'status_change',
                ${JSON.stringify({ from, to: rows[0].status })}::jsonb, ${session.name})`;
    } catch (e) {
      console.error("activity persist failed:", (e as Error).message);
    }

    // Outcome and ownership, stamped from the move itself rather than typed.
    //
    // closed_at is set on entering a closed stage and cleared otherwise, which
    // also covers dragging a card back out of Closed -- a date that survived
    // that would put a lead in "what we closed this term" forever. Won -> Lost
    // restamps, which is right: the outcome changed today.
    //
    // owner_name is coalesced, so it records whoever first moved the card off
    // Prospects and is never overwritten by the next person to touch it. The
    // Claim button changes it deliberately through EDITABLE.
    const entering = CLOSED.has(rows[0].status);
    try {
      const [stamped] = await db()`
        update enactus_leads
           set closed_at  = ${entering ? new Date().toISOString() : null},
               owner_name = coalesce(owner_name, ${from === "prospects" ? session.name : null})
         where id = ${id}
         returning *`;
      if (stamped) rows[0] = stamped;
    } catch (e) {
      console.error("stage stamp failed:", (e as Error).message);
    }

    // Moving a lead off the prospects column is the moment someone decided to
    // contact it, and the only moment worth spending scrape credits on.
    //
    // after(), not a bare floating promise: the drag has to land instantly,
    // but a promise left running past the response gets frozen with the
    // function on Vercel and the write silently never happens. The result
    // goes straight onto the row the board re-reads, so the card fills in on
    // its own.
    if (from === "prospects" && rows[0].status !== "prospects" && !rows[0].contact_email) {
      after(async () => {
        try {
          await findContactFor(id, session.name);
        } catch (e) {
          console.error("auto contact lookup failed:", (e as Error).message);
        }
      });
    }
  }

  return Response.json({ lead: rows[0] });
});

export const DELETE = route(async (_session, _req: Request, { params }: Ctx) => {
  const { id } = await params;
  await db()`delete from enactus_leads where id = ${id}`;
  return Response.json({ ok: true });
});
