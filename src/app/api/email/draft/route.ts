import { route } from "@/lib/auth";
import { db } from "@/lib/db";
import { streamReasoner, STRUCTURER, STRUCTURER_PROVIDER } from "@/lib/llm";
import { stripEmDashes } from "@/lib/sanitize";
import { Lead } from "@/lib/types";
import { ENACTUS_ORG, ENACTUS_PROJECTS, ENACTUS_VENTURES } from "@/lib/enactus";
import { greet, lint, projectNames } from "@/lib/email-lint";
import { emailBelongsTo } from "@/lib/firecrawl";
import type { NeonQueryFunction } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One short streamed completion, nothing like the agent's two-stage run.
export const maxDuration = 30;

// The shape the model must emit. The sign-off is deliberately absent: the
// sender's name and title are facts, so they are appended in code.
const STYLE = `Write like a real person emailing another person.

Reply in EXACTLY this shape and nothing else:

Subject: <6 to 9 plain words naming this company and what you want. Never start with Supporting, Partnering, Connecting or Exploring.>

<1 to 2 sentences naming something specific and true about THIS company, taken from the facts you are given.>

<2 to 3 sentences on what Enactus SFU is and what you are asking them for.>

<OPTIONAL bullet block. Include it ONLY if the material above names something concrete the sponsor gets. If it does not, leave this block out entirely and write one more sentence of the ask instead. Never invent a benefit.>

<One sentence close asking a yes or no question they can answer by replying to this email.>

Hard rules:
- Keep every blank line above. Bullets, if any, start with "- " at the start of the line.
- Under 150 words after the subject line.
- NEVER use em dashes or en dashes. Short sentences, commas, periods.
- No corporate filler: no "I hope this finds you well", "reach out", "leverage", "synergy", "excited to partner", "circle back".
- Plain text only. No markdown, no bold, no headings.
- Every claim, number, name and program must appear word for word in the facts or the material above, including anything you say about an Enactus project. Do not add a headquarters, a city, a dollar figure, or past work with SFU.
- Do NOT write a sign-off. It is appended for you.`;

// Models append a sign-off however firmly the prompt forbids it, and the real
// name and title must not come from the model, so the block is cut and rebuilt.
const SIGNOFF = /\n+[ \t]*(best|best regards|thanks|thank you|sincerely|regards|kind regards|warmly|cheers)[,.!]?[ \t]*(\n[\s\S]*)?$/i;

function signOff(body: string, name: string, title: string): string {
  return `${body.replace(SIGNOFF, "").trimEnd()}\n\nBest,\n${name}${title ? `\n${title}` : ""}`;
}

/**
 * Enforce the blank line around the greeting and the bullet block.
 *
 * Measured over repeated generations, the model runs the bullets straight onto
 * the paragraph above roughly one time in three however the prompt is worded.
 * Spacing is the whole point of the rewrite, so it is applied here instead.
 */
function tidy(body: string): string {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const prev = out[out.length - 1] ?? "";
    if (!line && !prev) continue; // collapse blank runs
    const bulletEdge = line.startsWith("- ") !== prev.startsWith("- ");
    if (line && prev && (bulletEdge || /^(hi|hello|hey)\b.*,$/i.test(prev))) out.push("");
    out.push(line);
  }
  return out.join("\n").trim();
}

type DraftEvent =
  | { type: "meta"; to: string | null; draftId: string | null }
  | { type: "subject"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; draftId: string | null; subject: string; body: string; warnings?: string[] }
  | { type: "error"; message: string };

function ndjson(produce: (emit: (e: DraftEvent) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: DraftEvent) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        } catch {
          // controller closed
        }
      };
      try {
        await produce(emit);
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Write the finished draft, updating the row we read rather than adding another
 * (four leads had eleven rows between them before this).
 *
 * sender_id and template_id arrive with a migration owned by a separate change.
 * Naming a column that does not exist fails the whole statement, so the write is
 * retried without them instead of throwing away the email that was just written.
 */
async function saveDraft(
  sql: NeonQueryFunction<false, false>,
  p: { id: string | null; leadId: string; subject: string; body: string; name: string; senderId: string | null; templateId: string | null }
): Promise<string | null> {
  const attempt = async (extras: boolean) => {
    const cols = extras ? ["sender_id", "template_id"] : [];
    const vals = extras ? [p.senderId, p.templateId] : [];
    const rows = p.id
      ? await sql.query(
          `update enactus_email_drafts set subject = $1, body = $2, status = 'draft'` +
            cols.map((c, i) => `, ${c} = $${i + 4}`).join("") +
            ` where id = $3 returning id`,
          [p.subject, p.body, p.id, ...vals]
        )
      : await sql.query(
          `insert into enactus_email_drafts (lead_id, subject, body, status, created_by_name${cols.map((c) => `, ${c}`).join("")})` +
            ` values ($1, $2, $3, 'draft', $4${cols.map((_, i) => `, $${i + 5}`).join("")}) returning id`,
          [p.leadId, p.subject, p.body, p.name, ...vals]
        );
    return (rows[0] as { id: string } | undefined)?.id ?? null;
  };
  try {
    return await attempt(Boolean(p.senderId || p.templateId));
  } catch {
    try {
      return await attempt(false);
    } catch (e) {
      console.error("draft persist failed:", (e as Error).message);
      return null;
    }
  }
}

const PROJECT_NAMES = projectNames(ENACTUS_PROJECTS);

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const POST = route(async (session, req: Request) => {
  const b = await req.json().catch(() => ({}));
  const leadId = b.leadId;
  if (!leadId) return Response.json({ error: "leadId required" }, { status: 400 });
  const force = Boolean(b.force);
  const senderId = str(b.senderId, 64) || null;
  const templateId = str(b.templateId, 64) || null;
  const senderName = str(b.senderName, 80) || session.name;
  const senderTitle = str(b.senderTitle, 80);
  // A template was picked: the client already substituted the placeholders in
  // code, so there is nothing for the model to do.
  const preSubject = str(b.subject, 300);
  const preBody = str(b.body);

  const sql = db();
  const [lead] = await sql`select * from enactus_leads where id = ${leadId}`;
  if (!lead) return Response.json({ error: "Lead not found" }, { status: 404 });
  const l = lead as Lead;

  let prev: { id: string; subject: string | null; body: string | null } | null = null;
  try {
    const rows = (await sql`
      select id, subject, body from enactus_email_drafts
      where lead_id = ${l.id} order by created_at desc limit 1`) as { id: string; subject: string | null; body: string | null }[];
    prev = rows[0] ?? null;
  } catch (e) {
    console.error("draft lookup failed:", (e as Error).message);
  }

  // Cermaq and Mowi both got the same Alara paragraph. Matching siblings on
  // industry missed it -- "Aquaculture" and "Aquaculture, Seafood" are different
  // strings -- so the question is now "which projects did the last few emails
  // use", regardless of who they went to. Fed to the model, not just to lint:
  // a warning after the fact cannot make the email different.
  let recentProjects: string[] = [];
  try {
    const rows = (await sql`
      select body from enactus_email_drafts
      where lead_id <> ${l.id} and body is not null
      order by created_at desc limit 5`) as { body: string }[];
    recentProjects = PROJECT_NAMES.filter((p) => rows.some((r) => r.body.includes(p)));
  } catch (e) {
    console.error("recent draft lookup failed:", (e as Error).message);
  }

  const isSales = l.mode === "sales";
  // Sales mode shipped with no description of the product at all, so "introduce
  // your product" left the model nothing to do but invent one. These are the
  // only real ventures, and agent.ts already scores sales leads against them.
  // A grant-receiving nonprofit asked for cash reads as nobody having looked past
  // the industry label: Burnaby Arts Council is quoted in its own draft as
  // "grant-receiving and grant-giving" and then asked for money.
  // Known limit: name/industry regex, the real fix is disqualifying these upstream
  // in apollo.ts MEMBERSHIP_NAME.
  const raisesOwnFunds = /non-?profit|society|council|association|foundation|charit/i.test(`${l.company} ${l.industry ?? ""}`);
  // Telling the model "do not ask for money" while still handing it
  // "Angle: monetary" is two instructions that cannot both be followed, so the
  // angle itself drops the money ask rather than arguing with it downstream.
  const angle = (l.sponsorship_type ?? []).filter((t) => !(raisesOwnFunds && t === "monetary"));
  const avoid = recentProjects.length
    ? `\n\nThe last few emails already pitched: ${recentProjects.join(", ")}. Choose a different project unless one of those is clearly the best fit for this company.`
    : "";
  const goal = isSales
    ? `You are ${senderName}, a project manager reaching out to a potential customer to introduce your product and ask for a short intro call.\n\n${ENACTUS_VENTURES}\n\nPitch ONE of these ventures, the one this company could actually stock, buy or distribute. Every claim about the product must come from the description above.`
    : `You are ${senderName}, on the External Relations team at Enactus SFU. You are asking this company to support Enactus SFU with sponsorship (monetary and/or in-kind).\n\n${ENACTUS_ORG}\n\n${ENACTUS_PROJECTS.replace(/\s*\(aligns with:[^)]*\)/g, "")}\n\nGround the email in ONE specific Enactus SFU project that best fits this company (use the "Why they fit" note if it names one). Mention that project by name and why it aligns with them, rather than pitching Enactus generically. The Angle line is binding: if it says in_kind, ask only for a good or service this company already sells and name that item; if it says monetary, ask for money and say the one thing it pays for. Never leave the ask type unstated.${raisesOwnFunds ? "\n\nThis organization raises its own funds. Do not ask it for money. Ask for a partnership, a venue, an introduction or in-kind help." : ""}${avoid}`;

  const facts = [
    `Company: ${l.company}`,
    l.contact_name ? `Contact: ${l.contact_name}${l.contact_role ? `, ${l.contact_role}` : ""}` : "",
    l.industry ? `Industry: ${l.industry}` : "",
    l.location ? `Location: ${l.location}` : "",
    l.description ? `About: ${l.description}` : "",
    l.connection_type && l.connection_type !== "none" ? `Connection: ${l.connection_type}${l.connection_note ? ` (${l.connection_note})` : ""}` : "",
    l.why_fit ? `Why they fit: ${l.why_fit}` : "",
    angle.length ? `Angle: ${angle.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  // Opening the modal must not re-bill a generation: the newest draft is the
  // answer unless the user asked for a new one or picked a template. It still
  // gets linted -- this is the path the user is on at the moment they hit send,
  // so it is the one that most needs the warnings.
  const cached = prev;
  if (!force && !preBody && cached?.body) {
    return ndjson(async (emit) => {
      emit({ type: "meta", to: l.contact_email, draftId: cached.id });
      emit({ type: "subject", text: cached.subject ?? "" });
      emit({ type: "delta", text: cached.body ?? "" });
      emit({
        type: "done",
        draftId: cached.id,
        subject: cached.subject ?? "",
        body: cached.body ?? "",
        warnings: lint(cached.body ?? "", { facts, goal, connection: l.connection_type, recentProjects, projectNames: PROJECT_NAMES, email: l.contact_email }),
      });
    });
  }

  return ndjson(async (emit) => {
    emit({ type: "meta", to: l.contact_email, draftId: prev?.id ?? null });

    let subject = "";
    let body = "";
    let warnings: string[] = [];

    if (preBody) {
      subject = stripEmDashes(preSubject || `Enactus SFU x ${l.company}`);
      // The client cannot know the session name, so it leaves that one token.
      body = stripEmDashes(preBody).replaceAll("{{sender_name}}", senderName);
      emit({ type: "subject", text: subject });
      emit({ type: "delta", text: body });
    } else {
      let head = "";
      let inBody = false;
      await streamReasoner(
        [
          { role: "system", content: `${goal}\n\n${STYLE}` },
          { role: "user", content: `Draft a first-touch outreach email to this lead.\n\n${facts}` },
        ],
        {
          onContent: (d) => {
            if (inBody) {
              body += d;
              emit({ type: "delta", text: d });
              return;
            }
            // Everything up to the first newline is the subject line. Leading
            // whitespace is dropped first: one blank delta ahead of "Subject:"
            // would otherwise make the empty string the subject and push the
            // real subject line into the body.
            head = (head + d).replace(/^\s+/, "");
            const nl = head.indexOf("\n");
            if (nl === -1) return;
            inBody = true;
            subject = head.slice(0, nl).replace(/^\s*subject\s*:\s*/i, "").trim();
            emit({ type: "subject", text: subject });
            const rest = head.slice(nl + 1).replace(/^\n+/, "");
            if (rest) {
              body += rest;
              emit({ type: "delta", text: rest });
            }
          },
        },
        { model: STRUCTURER, provider: STRUCTURER_PROVIDER, maxTokens: 600, temperature: 0.6 }
      );
      // Single-line answer: no newline ever arrived, so nothing was classified.
      if (!inBody) {
        if (/^\s*subject\s*:/i.test(head)) subject = head.replace(/^\s*subject\s*:\s*/i, "").trim();
        else body = head;
      }

      subject = stripEmDashes(subject) || `Enactus SFU sponsorship request for ${l.company}`;
      // `done` carries the whole body, so the client's streamed copy is replaced
      // by this one and never keeps a model-written sign-off.
      // emailBelongsTo already encodes the address forms the contact lookup
      // trusts when it attributes a personal address, so reusing it here means
      // the greeting and the attribution can never disagree about whether this
      // mailbox belongs to this person.
      const ownAddress = Boolean(
        l.contact_email && l.contact_name && emailBelongsTo(l.contact_email, l.contact_name)
      );
      body = signOff(greet(tidy(stripEmDashes(body)), l.contact_name ?? "", l.contact_email, ownAddress), senderName, senderTitle);
      warnings = lint(body, { facts, goal, connection: l.connection_type, recentProjects, projectNames: PROJECT_NAMES, email: l.contact_email });
    }

    const draftId = await saveDraft(sql, {
      id: prev?.id ?? null,
      leadId: l.id,
      subject,
      body,
      name: session.name,
      senderId,
      templateId,
    });
    emit({ type: "done", draftId, subject, body, warnings });
  });
});
