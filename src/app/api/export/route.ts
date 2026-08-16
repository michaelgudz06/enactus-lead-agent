import { getSession, secretMatches } from "@/lib/auth";
import { db, hasDatabaseUrl } from "@/lib/db";
import { toCsv } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full-table dump of a few hundred rows, but the export exists precisely for
// the day the table is not small, so give it more than the default headroom.
export const maxDuration = 60;

/**
 * The escape hatch.
 *
 * Two ways in, because the two callers are different: a signed-in volunteer
 * clicking the link in Settings, and an unattended backup job that has no
 * cookie. The job authenticates with BACKUP_TOKEN, which is checked in constant
 * time and is simply unavailable if the variable is unset -- an absent token
 * must never mean "everyone is allowed".
 */
const tokenMatches = (header: string | null): boolean =>
  secretMatches((header ?? "").replace(/^Bearer\s+/i, ""), process.env.BACKUP_TOKEN);

// Explicit and ordered rather than `select *`: this file is read by whoever
// inherits the board, and a column order that starts with the company and the
// stage is worth more than one that starts with a uuid.
const LEAD_COLUMNS = [
  "company", "status", "amount", "owner_name", "closed_at",
  "contact_name", "contact_role", "contact_email", "website", "location",
  "industry", "connection_type", "connection_note", "sponsorship_type",
  "why_fit", "description", "reasoning", "sources", "mode",
  "created_by_name", "created_at", "updated_at", "id",
];

export async function GET(req: Request): Promise<Response> {
  const authorized =
    tokenMatches(req.headers.get("authorization")) || Boolean(await getSession());
  if (!authorized) return new Response("Unauthorized", { status: 401 });
  if (!hasDatabaseUrl()) {
    return Response.json({ error: "DATABASE_URL missing" }, { status: 400 });
  }

  const rows = await db()`
    select * from enactus_leads
    order by status, coalesce(amount, 0) desc, company asc`;

  const day = new Date().toISOString().slice(0, 10);
  // The BOM is not decoration: without it Excel reads a UTF-8 CSV as Latin-1
  // and every accented company name in the Lower Mainland comes out mangled.
  const body = "﻿" + toCsv(rows as Record<string, unknown>[], LEAD_COLUMNS);

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="enactus-leads-${day}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
