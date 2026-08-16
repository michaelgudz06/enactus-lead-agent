"use client";

import { useRef, useState } from "react";
import { Mail, ChevronDown, ExternalLink, Brain, AtSign, X, Clock } from "lucide-react";
import { Lead } from "@/lib/types";
import { logoUrl, monogram } from "@/lib/logo";
import { nextAction } from "@/lib/next-action";
import ConnectionChip from "./ConnectionChip";

export default function LeadCard({
  lead,
  onEmail,
  onDelete,
  draggable,
  onDragStart,
  now,
}: {
  lead: Lead;
  /**
   * When "now" is, stamped by the board when it loaded these leads. A prop
   * rather than Date.now() in here because reading the clock during render is
   * impure: it makes the card render differently on the server than on the
   * client, and React has no reason not to re-render it at any moment. Omitted
   * on the agent page, where every lead is a brand-new prospect and no
   * follow-up chip could apply anyway.
   */
  now?: number;
  onEmail?: (lead: Lead) => void;
  // One handler: both pages hard-DELETE the same row and differ only in how
  // they bookkeep it afterwards, which is the page's business, not the card's.
  onDelete?: (id: string) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}) {
  const [showReason, setShowReason] = useState(false);
  const [noLogo, setNoLogo] = useState(false);

  // The route persists what it finds, so this local copy only has to survive
  // until the next load -- no need to push it back up to either page.
  const [found, setFound] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const email = lead.contact_email ?? found;

  const logo = logoUrl(lead.website);
  const meta = [lead.industry, lead.location].filter(Boolean).join(" · ");
  // connection_type is `text default 'none'` and therefore nullable, and null
  // is not "none": without the first clause a null lead renders this row empty
  // and still bills its mt-2, which is the gap it exists to remove.
  const hasChips =
    (lead.connection_type && lead.connection_type !== "none") || lead.sponsorship_type?.length > 0;
  const due = now ? nextAction(lead, now) : null;

  // A press that drifts a few pixels off a button starts a card drag, so the
  // lead changes column and the click never fires. draggable={false} on the
  // button cannot fix it -- buttons are not drag sources to begin with, and the
  // drag runs from the nearest draggable ANCESTOR, which is this card. The
  // pressed element is only knowable at pointerdown; dragstart reports the card.
  const fromControl = useRef(false);

  const findContact = async () => {
    setFinding(true);
    setFindError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/contact`, { method: "POST" });
      const data = await res.json();
      if (data.email) setFound(data.email);
      else setFindError(data.error ?? "No published address found.");
    } catch {
      setFindError("Search failed. Try again.");
    } finally {
      setFinding(false);
    }
  };

  return (
    <div
      draggable={draggable}
      onPointerDownCapture={(e) => {
        fromControl.current = !!(e.target as HTMLElement).closest?.("button, a");
      }}
      onDragStart={(e) => {
        if (fromControl.current) return void e.preventDefault();
        onDragStart?.(e);
      }}
      className="rounded-xl border p-3 card-hover animate-in"
      style={{ background: "var(--surface2)", borderColor: "var(--border)", cursor: draggable ? "grab" : "default" }}
    >
      <div className="flex items-start gap-2">
        {logo && !noLogo ? (
          // Plain <img>, not next/image: the s2 URL's per-lead query string
          // cannot be matched by an images.remotePatterns `search`, and omitting
          // `search` implies `**`, which the Next 16 docs warn against.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt=""
            width={32}
            height={32}
            loading="lazy"
            referrerPolicy="no-referrer"
            // An <img> is a drag source by default, so a press here would drag
            // the image URL instead of the card.
            draggable={false}
            onError={() => setNoLogo(true)}
            // Known limit: Google answers an unknown domain with HTTP 404 that
            // still carries a decodable 16x16 globe, so onError never fires --
            // the decoded size is the only tell. Costs the six real hosts that
            // publish nothing bigger than 16px; upscaled they were mush anyway.
            // Failing toward the monogram is the safe direction if 16 changes.
            onLoad={(e) => { if (e.currentTarget.naturalWidth <= 16) setNoLogo(true); }}
            className="w-8 h-8 rounded shrink-0 object-contain p-1"
            // White tile, not --surface2: favicons are transparent PNGs with
            // dark marks as often as light ones and would vanish on #1a1d23.
            // It also holds the final size while the request is in flight.
            style={{ background: "#fff" }}
          />
        ) : (
          <div
            className="w-8 h-8 rounded shrink-0 grid place-items-center text-xs font-bold"
            style={{ background: "var(--surface3)", color: "var(--muted)" }}
            aria-hidden
          >
            {monogram(lead.company)}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm leading-tight truncate" title={lead.company}>{lead.company}</div>
          {meta && (
            <div className="text-[10px] truncate mt-0.5" style={{ color: "var(--faint)" }}>{meta}</div>
          )}
        </div>

        {onDelete && (
          <button
            // DELETE /api/leads/:id is a hard delete and both child tables are
            // `on delete cascade`, so this drops the drafts and the whole
            // timeline with the company, against Neon Free's 6-hour restore
            // window. One line of confirm is cheaper than the recovery.
            onClick={() => {
              if (confirm(`Delete ${lead.company}? This also deletes its drafts and history.`)) onDelete(lead.id);
            }}
            // p-1.5 not p-1: 14px icon + 12px padding clears the 24x24 minimum,
            // and this sits in the corner a hand grabs to drag.
            className="shrink-0 p-1.5 -mt-1.5 -mr-1.5 rounded-lg hover:bg-[var(--surface3)]"
            style={{ color: "var(--faint)" }}
            title="Delete this lead"
            aria-label={`Delete ${lead.company}`}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* ConnectionChip returns null for "none" and sponsorship_type is often
          [], so this row used to render empty and still bill its mt-2. */}
      {hasChips && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <ConnectionChip type={lead.connection_type} />
          {lead.sponsorship_type?.map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--surface3)", color: "var(--blue)" }}>
              {t === "in_kind" ? "in-kind" : t}
            </span>
          ))}
        </div>
      )}

      {lead.why_fit && (
        <p className="mt-2 text-xs leading-relaxed line-clamp-3" style={{ color: "var(--text)" }} title={lead.why_fit}>
          <span style={{ color: "var(--gold)" }}>Why: </span>
          {lead.why_fit}
        </p>
      )}

      {(lead.contact_name || email) && (
        <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          {lead.contact_name && <div className="font-medium truncate" style={{ color: "var(--text)" }}>{lead.contact_name}{lead.contact_role ? <span style={{ color: "var(--faint)" }}> · {lead.contact_role}</span> : null}</div>}
          {email && <div className="truncate">{email}</div>}
        </div>
      )}

      {findError && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--faint)" }}>{findError}</p>
      )}

      {/* Derived every render from the stage and the silence, so it clears
          itself the moment someone logs a call or drags the card -- there is no
          "done" to remember to tick. Prospects never get one: their next action
          is already the buttons below. */}
      {due && (
        <div
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold rounded-md px-1.5 py-0.5"
          style={{ background: "rgba(245,158,11,.12)", color: "#f59e0b" }}
        >
          <Clock size={11} /> {due.label}
        </div>
      )}

      {lead.amount != null && (
        <div className="mt-2 text-xs font-semibold" style={{ color: "#4ade80" }}>
          ${lead.amount.toLocaleString()}
          {lead.owner_name && (
            <span className="font-normal" style={{ color: "var(--faint)" }}> · {lead.owner_name}</span>
          )}
        </div>
      )}

      {/* Not trimmed to its first sentence. The stored rows run
          [setup] -> [evidence] -> [first ask], so sentence one is the throat-
          clearing on 41 of 110 ("The verified company data confirms...") and
          the cut drops the concrete first ask on all of them. This panel is
          collapsed by default and already scrolls, so the trim bought no card
          height -- the ask for a shorter card is met by the clamp on Why above. */}
      {lead.reasoning && (
        <div className="mt-2">
          <button onClick={() => setShowReason((s) => !s)} className="flex items-center gap-1 text-[11px] font-medium" style={{ color: "var(--faint)" }}>
            <Brain size={12} /> Why we chose {lead.company.length > 18 ? "this company" : lead.company} <ChevronDown size={12} className={showReason ? "rotate-180" : ""} />
          </button>
          {showReason && (
            <p className="mt-1.5 text-[11px] leading-relaxed max-h-56 overflow-y-auto reason-scroll p-2.5 rounded" style={{ background: "var(--bg)", color: "var(--muted)" }}>
              {lead.reasoning}
            </p>
          )}
        </div>
      )}

      {/* flex-wrap: without it a squeezed row breaks the LABELS mid-word. */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {onEmail && (
          <button
            onClick={() => onEmail(lead)}
            draggable={false}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: "var(--accent)", color: "#fff" }}
          >
            <Mail size={13} /> Draft email
          </button>
        )}
        {/* Icons only: three labelled controls need ~273px of a 256px column. */}
        <div className="ml-auto flex items-center gap-1">
          {!email && (
            <button
              onClick={findContact}
              disabled={finding}
              // The label went with the icon, so the pulse is the only busy
              // cue left on screen and screen readers get nothing without this.
              aria-busy={finding}
              draggable={false}
              className="p-1.5 rounded-lg disabled:opacity-60"
              style={{ background: "var(--surface3)", color: "var(--muted)" }}
              title="Look for a published contact address on their site"
              aria-label="Find contact"
            >
              <AtSign size={13} className={finding ? "dot-pulse" : ""} />
            </button>
          )}
          {lead.sources?.[0]?.url && (
            <a
              href={lead.sources[0].url}
              target="_blank"
              rel="noreferrer"
              // Anchors are natively draggable too -- they drag their URL.
              draggable={false}
              className="p-1.5 rounded-lg"
              style={{ color: "var(--muted)", background: "var(--surface3)" }}
              title={lead.sources[0].title || "Where the agent found them"}
              aria-label="Open source page"
            >
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
