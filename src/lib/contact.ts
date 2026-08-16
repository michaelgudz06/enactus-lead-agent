// Find a named contact for one lead and persist it, with the evidence.
//
// Two callers: the "Find contact" button on a card, and the automatic run when
// a lead is dragged out of prospects. They agree on everything that matters --
// coalesce rules, what counts as evidence, what gets logged -- so they share
// this rather than each keeping their own copy of it.

import { db } from "./db";
import { findContactEmail, type ContactFind } from "./firecrawl";

/**
 * Never throws and never returns a partial write: either the lead row and the
 * activity row both reflect what was found, or nothing was found and neither
 * moved. Callers treat "no contact" as an ordinary outcome, not a failure.
 */
export async function findContactFor(
  leadId: string,
  actorName: string,
  opts: { signal?: AbortSignal } = {}
): Promise<ContactFind | { error: string }> {
  const rows = await db()`select website from enactus_leads where id = ${leadId}`;
  if (!rows.length) return { error: "Lead not found" };

  const website = rows[0].website as string | null;
  if (!website) {
    // Expected, not an error: the website guard nulls any site that does not
    // belong to the company, so plenty of good leads arrive without one.
    return {
      email: null,
      name: null,
      role: null,
      sourceUrl: null,
      all: [],
      people: [],
      checked: 0,
      error: "No website on file — the agent could not confirm one for this company.",
    };
  }

  const found = await findContactEmail(website, {
    signal: opts.signal ?? AbortSignal.timeout(25_000),
  });
  if (!found.email && !found.name) return found;

  // coalesce so a generic info@ can never overwrite an address that was already
  // verified against fetched page text during the run. The role is written only
  // alongside the name it was published with -- hanging a scraped title on
  // someone else's name is the same fabrication as inventing the title.
  await db().query(
    `update enactus_leads
        set contact_name = coalesce(contact_name, $1),
            contact_role = case when contact_name is null then coalesce($2, contact_role) else contact_role end,
            contact_email = coalesce(contact_email, $3),
            updated_at = now()
      where id = $4`,
    [found.name, found.role, found.email, leadId]
  );

  // The evidence URL is the point of the row: it is what lets anyone check the
  // contact later without re-running the scrape. Best effort on purpose -- an
  // audit row is never worth failing a lookup someone is waiting on.
  try {
    await db().query(
      `insert into enactus_lead_activity (lead_id, kind, body, meta, actor_name)
       values ($1, 'contact_found', $2, $3, $4)`,
      [
        leadId,
        [found.name, found.role, found.email].filter(Boolean).join(" · "),
        JSON.stringify({
          source_url: found.people[0]?.sourceUrl ?? found.sourceUrl,
          email_source_url: found.sourceUrl,
          name: found.name,
          role: found.role,
          email: found.email,
          emails_found: found.all,
          pages_checked: found.checked,
        }),
        actorName,
      ]
    );
  } catch {
    // Logging is not the deliverable; the contact is.
  }

  return found;
}
