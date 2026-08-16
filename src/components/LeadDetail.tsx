"use client";

import { useEffect, useState } from "react";
import { X, ExternalLink, Globe, MapPin, Mail } from "lucide-react";
import { Lead, STATUS_COLUMNS } from "@/lib/types";
import { useApp } from "./AppShell";
import ConnectionChip from "./ConnectionChip";
import ActivityLog from "./ActivityLog";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--faint)" }}>{label}</div>
      <div className="text-xs mt-0.5 leading-relaxed" style={{ color: "var(--text)" }}>{children}</div>
    </div>
  );
}

export default function LeadDetail({
  lead,
  onClose,
  onUpdated,
}: {
  lead: Lead;
  onClose: () => void;
  /** The panel writes; the board owns the row. Without this the card behind it
   *  keeps showing the old amount until the next refresh. */
  onUpdated?: (lead: Lead) => void;
}) {
  const { name } = useApp();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const col = STATUS_COLUMNS.find((c) => c.id === lead.status);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.lead) onUpdated?.(data.lead);
    } finally {
      setSaving(false);
    }
  }

  // Blur rather than a Save button: one field, and the value is already in the
  // input. Blank clears it back to null so a mistyped amount can be undone.
  function saveAmount(raw: string) {
    const cleaned = raw.replace(/[$,\s]/g, "");
    if (cleaned === "") return lead.amount == null ? undefined : void patch({ amount: null });
    const n = Number(cleaned);
    if (Number.isInteger(n) && n >= 0 && n !== lead.amount) void patch({ amount: n });
  }

  return (
    <div className="fixed inset-0 z-[100] flex justify-end" style={{ background: "rgba(0,0,0,.6)" }} onClick={onClose}>
      <div
        className="w-full max-w-md h-full border-l flex flex-col animate-in"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-3.5 border-b shrink-0" style={{ borderColor: "var(--border)" }}>
          <div className="min-w-0">
            <div className="font-semibold text-sm truncate">{lead.company}</div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {col && (
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${col.color}22`, color: col.color }}>
                  {col.label}
                </span>
              )}
              <ConnectionChip type={lead.connection_type} />
              {/* No fit score. The agent stopped producing one (agent.ts:809)
                  because the model invented it -- a number nothing computed,
                  rendered next to facts that were checked. LeadCard dropped it
                  already; this was the last place 11 legacy rows still showed
                  a precise-looking 65-95 that means nothing. The column stays
                  so the old rows are not rewritten. */}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--surface3)] shrink-0" style={{ color: "var(--muted)" }}>
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs" style={{ color: "var(--muted)" }}>
            {lead.website && (
              <a href={lead.website} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 min-w-0" style={{ color: "var(--blue)" }}>
                <Globe size={12} className="shrink-0" /> <span className="truncate">{lead.website.replace(/^https?:\/\//, "")}</span>
              </a>
            )}
            {lead.location && <span className="flex items-center gap-1.5"><MapPin size={12} /> {lead.location}</span>}
            {lead.industry && <span>{lead.industry}</span>}
          </div>

          {(lead.contact_name || lead.contact_email) && (
            <div className="rounded-xl border p-3" style={{ background: "var(--surface2)", borderColor: "var(--border)" }}>
              {lead.contact_name && (
                <div className="text-xs font-medium">
                  {lead.contact_name}
                  {lead.contact_role && <span style={{ color: "var(--faint)" }}> · {lead.contact_role}</span>}
                </div>
              )}
              {lead.contact_email && (
                <a href={`mailto:${lead.contact_email}`} className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: "var(--blue)" }}>
                  <Mail size={12} /> {lead.contact_email}
                </a>
              )}
            </div>
          )}

          {/* Amount and owner. The board asks for the amount once, on the drag
              into Closed / Won; this is where it gets corrected, and where a
              lead that is not closed yet can be given an expected value. Owner
              is stamped by the first person to move the card off Prospects, so
              Claim exists for the case where that was not the right person. */}
          <div className="rounded-xl border p-3 flex items-center gap-4" style={{ background: "var(--surface2)", borderColor: "var(--border)" }}>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--faint)" }}>Amount (CAD)</div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-sm" style={{ color: "var(--faint)" }}>$</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  disabled={saving}
                  defaultValue={lead.amount ?? ""}
                  key={lead.amount ?? "empty"}
                  onBlur={(e) => saveAmount(e.target.value)}
                  placeholder="—"
                  className="bg-transparent outline-none text-sm font-semibold w-24"
                  style={{ color: lead.amount != null ? "#4ade80" : "var(--text)" }}
                />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--faint)" }}>Owner</div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-sm truncate" style={{ color: lead.owner_name ? "var(--text)" : "var(--faint)" }}>
                  {lead.owner_name || "Unclaimed"}
                </span>
                {lead.owner_name !== name && (
                  <button
                    onClick={() => void patch({ owner_name: name })}
                    disabled={saving}
                    className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                    style={{ background: "var(--surface3)", color: "var(--blue)" }}
                  >
                    Claim
                  </button>
                )}
              </div>
            </div>
          </div>

          {lead.closed_at && (
            <Field label={lead.status === "closed_won" ? "Closed / Won" : "Closed / Lost"}>
              {new Date(lead.closed_at).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}
            </Field>
          )}

          {lead.description && <Field label="About">{lead.description}</Field>}
          {lead.why_fit && (
            <Field label="Why they fit"><span style={{ color: "var(--gold)" }}>{lead.why_fit}</span></Field>
          )}
          {lead.connection_note && <Field label="Connection">{lead.connection_note}</Field>}
          {lead.sponsorship_type?.length > 0 && (
            <Field label="Angle">
              <span className="flex flex-wrap gap-1.5 mt-1">
                {lead.sponsorship_type.map((t) => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--surface3)", color: "var(--blue)" }}>
                    {t === "in_kind" ? "in-kind" : t}
                  </span>
                ))}
              </span>
            </Field>
          )}
          {lead.reasoning && (
            <Field label="Agent reasoning">
              <span style={{ color: "var(--muted)" }}>{lead.reasoning}</span>
            </Field>
          )}

          {lead.sources?.length > 0 && (
            <Field label="Sources">
              <span className="flex flex-col gap-1 mt-1">
                {lead.sources.map((s, i) => (
                  <a
                    key={`${s.url}-${i}`}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 min-w-0"
                    style={{ color: "var(--blue)" }}
                  >
                    <ExternalLink size={11} className="shrink-0" />
                    <span className="truncate">{s.title || s.url}</span>
                  </a>
                ))}
              </span>
            </Field>
          )}

          <div className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
            <div className="text-[10px] uppercase tracking-wider mb-3" style={{ color: "var(--faint)" }}>Activity</div>
            <ActivityLog leadId={lead.id} />
          </div>
        </div>
      </div>
    </div>
  );
}
