"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, AtSign, Check, Download, Mail, RefreshCw, Search, X,
} from "lucide-react";
import { useApp } from "@/components/AppShell";
import { useRun } from "@/components/RunProvider";
import { CONNECTION_META, Lead, STATUS_COLUMNS, Status } from "@/lib/types";
import { nextAction } from "@/lib/next-action";
import { amountQuestion, parseAmount } from "@/lib/amount";
import { facets, filterLeads, industryFacets, sortLeads } from "@/lib/table";
import { logoUrl, monogram } from "@/lib/logo";
import { toCsv } from "@/lib/csv";
import LeadDetail from "@/components/LeadDetail";
import EmailModal from "@/components/EmailModal";

// Status sorts down the pipeline, not alphabetically. Derived from the same
// array the board renders, so a new stage needs no edit here.
const STATUS_RANK: Record<string, number> = Object.fromEntries(
  STATUS_COLUMNS.map((c, i) => [c.id, i])
);
const STATUS_META: Record<string, { label: string; color: string }> = Object.fromEntries(
  STATUS_COLUMNS.map((c) => [c.id, { label: c.label, color: c.color }])
);

type SortKey =
  | "company" | "status" | "contact_name" | "contact_email" | "owner_name"
  | "amount" | "industry" | "location" | "connection_type" | "created_by_name"
  | "created_at" | "last_activity_at";

const COLUMNS: { key: SortKey; label: string; width: string }[] = [
  { key: "company", label: "Company", width: "220px" },
  { key: "status", label: "Stage", width: "150px" },
  { key: "contact_name", label: "Contact", width: "160px" },
  { key: "contact_email", label: "Email", width: "220px" },
  { key: "owner_name", label: "Owner", width: "110px" },
  { key: "amount", label: "Amount", width: "100px" },
  { key: "last_activity_at", label: "Last touch", width: "140px" },
  { key: "industry", label: "Industry", width: "180px" },
  { key: "location", label: "Location", width: "170px" },
  { key: "connection_type", label: "Connection", width: "120px" },
  { key: "created_by_name", label: "Added by", width: "110px" },
  { key: "created_at", label: "Added", width: "110px" },
];

const CSV_COLUMNS = [
  "company", "status", "amount", "owner_name", "contact_name", "contact_role",
  "contact_email", "website", "location", "industry", "connection_type",
  "sponsorship_type", "why_fit", "created_by_name", "created_at",
];

function shortDate(v: string | null | undefined): string {
  if (!v) return "";
  const t = Date.parse(v);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })
    : "";
}

const CELL = "px-2.5 py-2 align-middle";

export default function LeadsPage() {
  const { mode, name } = useApp();
  const { leadSignal } = useRun();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState("");
  // Stamped at load, never during render: reading the clock while rendering is
  // impure and makes the server and client markup disagree. Same rule the board
  // follows.
  const [now, setNow] = useState(0);

  const [q, setQ] = useState("");
  const [statusSel, setStatusSel] = useState<string[]>([]);
  const [owner, setOwner] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [industry, setIndustry] = useState("");
  const [email, setEmail] = useState<"any" | "has" | "missing">("any");
  const [due, setDue] = useState(false);

  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "created_at", dir: -1 });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Lead | null>(null);
  const [emailLead, setEmailLead] = useState<Lead | null>(null);
  const [busy, setBusy] = useState(false);

  // Touches no state before its first await, which is what keeps the mount
  // effect below clear of the synchronous-setState rule. The spinner starts on
  // and is switched back on by the refresh button, which is an event handler.
  // Same shape the settings page uses.
  async function load() {
    const res = await fetch(`/api/leads?mode=${mode}`);
    const data = await res.json();
    setLeads(data.leads || []);
    setNow(Date.now());
    if (data.warning) setWarning(data.warning);
    setLoading(false);
  }

  /* eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- mode is the only real trigger; load() sets state only after its await */
  useEffect(() => { load(); }, [mode]);

  // A run started on the Agent tab keeps going while this table is on screen,
  // so its rows have to arrive here too. No skeleton on the way through: it
  // would lose the reader's place mid-scan on every arriving lead.
  /* eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- leadSignal is the trigger; load() sets state only after its await */
  useEffect(() => { if (leadSignal) void load(); }, [leadSignal]);

  const ownerFacets = useMemo(() => facets(leads, "owner_name", "Unassigned"), [leads]);
  const creatorFacets = useMemo(() => facets(leads, "created_by_name", "Unknown"), [leads]);
  // By word, not by value: the model writes industry free-hand, so whole-string
  // facets gave ~100 options of which ~90 had a count of 1.
  const industryWords = useMemo(() => industryFacets(leads), [leads]);

  const rows = useMemo(() => {
    const filtered = filterLeads(
      leads,
      {
        q,
        status: statusSel,
        owner: owner ? [owner] : [],
        createdBy: createdBy ? [createdBy] : [],
        industry: industry ? [industry] : [],
        email,
        due,
      },
      // now === 0 before the first load resolves, and nextAction with a zero
      // clock would call every lead overdue by 20 000 days.
      (l) => (now ? nextAction(l as Lead, now)?.kind === "followup" : false)
    );
    return sortLeads(filtered, sort.key, sort.dir, sort.key === "status" ? STATUS_RANK : undefined);
  }, [leads, q, statusSel, owner, createdBy, industry, email, due, now, sort]);

  // Counted over everything, not the filtered rows: these are the three numbers
  // that tell a volunteer what to do next, and they should not change when the
  // search box does.
  const totals = useMemo(() => ({
    noEmail: leads.filter((l) => !(l.contact_email ?? "").includes("@")).length,
    due: now ? leads.filter((l) => nextAction(l, now)?.kind === "followup").length : 0,
    unowned: leads.filter((l) => !l.owner_name).length,
  }), [leads, now]);

  const activeFilters =
    Boolean(q) || statusSel.length > 0 || Boolean(owner) || Boolean(createdBy) ||
    Boolean(industry) || email !== "any" || due;

  function clearFilters() {
    setQ(""); setStatusSel([]); setOwner(""); setCreatedBy(""); setIndustry("");
    setEmail("any"); setDue(false);
  }

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));
  }

  function togglePick(id: string) {
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  // Only the rows currently on screen: a "select all" that silently includes
  // 80 filtered-out leads is how a bulk stage change goes wrong.
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));
  function toggleAll() {
    setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)));
  }

  async function patch(id: string, body: Record<string, unknown>): Promise<Lead | null> {
    const res = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return (data.lead as Lead) ?? null;
  }

  function apply(updated: Lead) {
    setLeads((ls) => ls.map((l) => (l.id === updated.id ? updated : l)));
  }

  async function setStatus(lead: Lead, status: Status) {
    const body: { status: Status; amount?: number } = { status };
    // Same one question the board asks, at the same moment and with the same
    // escape: cancel or blank still moves the lead.
    if (status === "closed_won" && lead.amount == null) {
      const n = parseAmount(window.prompt(amountQuestion(lead.company)));
      if (n !== null) body.amount = n;
    }
    const prev = lead;
    apply({ ...lead, ...body });
    const updated = await patch(lead.id, body);
    // closed_at and owner_name are stamped server-side, so the returned row is
    // the only one that knows them.
    apply(updated ?? prev);
  }

  async function bulkStatus(status: Status) {
    // Deliberately no bulk close-won: the amount prompt is per-lead, and a
    // silent bulk win would book a pipeline total of zero.
    setBusy(true);
    try {
      for (const id of picked) {
        const updated = await patch(id, { status });
        if (updated) apply(updated);
      }
      setPicked(new Set());
    } finally {
      setBusy(false);
    }
  }

  async function bulkClaim() {
    setBusy(true);
    try {
      for (const id of picked) {
        const updated = await patch(id, { owner_name: name });
        if (updated) apply(updated);
      }
      setPicked(new Set());
    } finally {
      setBusy(false);
    }
  }

  function exportPicked() {
    const chosen = (picked.size ? rows.filter((r) => picked.has(r.id)) : rows) as unknown as Record<string, unknown>[];
    // The BOM is what makes Excel read this as UTF-8; without it every accented
    // company name arrives mangled. Same reason /api/export prepends one.
    const blob = new Blob(["﻿" + toCsv(chosen, CSV_COLUMNS)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `enactus-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="px-5 py-3 border-b space-y-2.5" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 border w-full max-w-sm" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <Search size={14} style={{ color: "var(--faint)" }} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search company, contact, industry, notes…"
              className="bg-transparent outline-none text-sm w-full"
            />
            {q && (
              <button onClick={() => setQ("")} style={{ color: "var(--faint)" }} aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs">
            <span style={{ color: "var(--faint)" }}>
              {rows.length === leads.length ? `${leads.length} leads` : `${rows.length} of ${leads.length}`}
            </span>
            {totals.due > 0 && (
              <button onClick={() => setDue((d) => !d)} className="font-semibold" style={{ color: "#f59e0b" }}>
                {totals.due} need follow-up
              </button>
            )}
            {totals.noEmail > 0 && (
              <button onClick={() => setEmail((e) => (e === "missing" ? "any" : "missing"))} className="font-semibold" style={{ color: "var(--blue)" }}>
                {totals.noEmail} without an email
              </button>
            )}
            <button
              onClick={exportPicked}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg"
              style={{ background: "var(--surface3)", color: "var(--muted)" }}
              title={picked.size ? `Export ${picked.size} selected` : "Export what is on screen"}
            >
              <Download size={13} /> CSV
            </button>
            <button onClick={() => { setLoading(true); load(); }} className="p-1.5 rounded-lg hover:bg-[var(--surface3)]" style={{ color: "var(--muted)" }} title="Refresh">
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        {/* Stage pills double as the stage filter and as the pipeline count. */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {STATUS_COLUMNS.map((c) => {
            const on = statusSel.includes(c.id);
            const n = leads.filter((l) => l.status === c.id).length;
            return (
              <button
                key={c.id}
                onClick={() => setStatusSel((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))}
                className="flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-lg border"
                style={{
                  background: on ? `${c.color}22` : "transparent",
                  borderColor: on ? c.color : "var(--border)",
                  color: on ? c.color : "var(--muted)",
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.color }} />
                {c.label}
                <span style={{ color: "var(--faint)" }}>{n}</span>
              </button>
            );
          })}

          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="text-[11px] rounded-lg border px-2 py-1 outline-none"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
          >
            <option value="">Any owner</option>
            {ownerFacets.map((f) => (
              <option key={f.key} value={f.key}>{f.label} ({f.count})</option>
            ))}
          </select>

          <select
            value={createdBy}
            onChange={(e) => setCreatedBy(e.target.value)}
            className="text-[11px] rounded-lg border px-2 py-1 outline-none"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
          >
            <option value="">Anyone added</option>
            {creatorFacets.map((f) => (
              <option key={f.key} value={f.key}>Added by {f.label} ({f.count})</option>
            ))}
          </select>

          <select
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            className="text-[11px] rounded-lg border px-2 py-1 outline-none max-w-[200px]"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
          >
            <option value="">Any industry</option>
            {industryWords.map((f) => (
              <option key={f.key} value={f.key}>{f.label} ({f.count})</option>
            ))}
          </select>

          <select
            value={email}
            onChange={(e) => setEmail(e.target.value as "any" | "has" | "missing")}
            className="text-[11px] rounded-lg border px-2 py-1 outline-none"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
          >
            <option value="any">Any email</option>
            <option value="has">Has an email</option>
            <option value="missing">No email yet</option>
          </select>

          {activeFilters && (
            <button onClick={clearFilters} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--faint)" }}>
              Clear filters
            </button>
          )}
        </div>

        {/* Bulk bar, only once something is selected. */}
        {picked.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap rounded-lg px-3 py-2 animate-in" style={{ background: "var(--surface2)" }}>
            <span className="text-xs font-semibold">{picked.size} selected</span>
            <button onClick={bulkClaim} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg font-medium disabled:opacity-50" style={{ background: "var(--surface3)", color: "var(--text)" }}>
              Assign to me
            </button>
            {STATUS_COLUMNS.filter((c) => c.id !== "closed_won").map((c) => (
              <button
                key={c.id}
                onClick={() => bulkStatus(c.id)}
                disabled={busy}
                className="text-[11px] px-2 py-1 rounded-lg font-medium disabled:opacity-50"
                style={{ background: "var(--surface3)", color: c.color }}
              >
                → {c.label}
              </button>
            ))}
            <span className="text-[10px]" style={{ color: "var(--faint)" }}>
              Closed / Won is one at a time — it asks for the amount.
            </span>
            <button onClick={() => setPicked(new Set())} className="ml-auto text-[11px]" style={{ color: "var(--faint)" }}>
              Clear
            </button>
          </div>
        )}
      </div>

      {warning && (
        <div className="mx-5 mt-3 text-xs rounded-lg px-3 py-2" style={{ background: "rgba(230,57,70,.1)", color: "var(--text)" }}>
          {warning} — leads can’t load until DATABASE_URL is set in the environment.
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="text-xs border-collapse" style={{ minWidth: "max-content" }}>
          <thead className="sticky top-0 z-20">
            <tr style={{ background: "var(--surface)" }}>
              <th className={`${CELL} sticky left-0 z-30 border-b`} style={{ background: "var(--surface)", borderColor: "var(--border)", width: "34px" }}>
                <input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="Select all rows shown" />
              </th>
              {COLUMNS.map((c, i) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  className={`${CELL} text-left font-semibold whitespace-nowrap cursor-pointer select-none border-b ${i === 0 ? "sticky left-[34px] z-30" : ""}`}
                  style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)", minWidth: c.width }}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.label}
                    {sort.key === c.key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </span>
                </th>
              ))}
              <th className={`${CELL} border-b`} style={{ background: "var(--surface)", borderColor: "var(--border)", width: "84px" }} />
            </tr>
          </thead>

          <tbody>
            {loading ? (
              [...Array(8)].map((_, i) => (
                <tr key={i}><td colSpan={COLUMNS.length + 2} className="p-1.5"><div className="h-7 rounded shimmer" /></td></tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 2} className="text-center py-16" style={{ color: "var(--faint)" }}>
                  {leads.length === 0
                    ? "No leads yet — find some on the Agent tab."
                    : "Nothing matches these filters."}
                </td>
              </tr>
            ) : (
              rows.map((l) => {
                const on = picked.has(l.id);
                const meta = STATUS_META[l.status];
                const action = now ? nextAction(l, now) : null;
                const logo = logoUrl(l.website);
                const conn = CONNECTION_META[l.connection_type] ?? CONNECTION_META.none;
                return (
                  <tr
                    key={l.id}
                    className="border-b hover:bg-[var(--surface2)]"
                    style={{ borderColor: "var(--border)", background: on ? "var(--surface2)" : undefined }}
                  >
                    <td className={`${CELL} sticky left-0 z-10`} style={{ background: on ? "var(--surface2)" : "var(--bg)" }}>
                      <input type="checkbox" checked={on} onChange={() => togglePick(l.id)} aria-label={`Select ${l.company}`} />
                    </td>

                    <td
                      className={`${CELL} sticky left-[34px] z-10 cursor-pointer`}
                      style={{ background: on ? "var(--surface2)" : "var(--bg)" }}
                      onClick={() => setDetail(l)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {logo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={logo} alt="" width={16} height={16} loading="lazy" referrerPolicy="no-referrer"
                            className="w-4 h-4 rounded shrink-0 object-contain" style={{ background: "#fff" }} />
                        ) : (
                          <span className="w-4 h-4 rounded shrink-0 grid place-items-center text-[9px] font-bold" style={{ background: "var(--surface3)", color: "var(--muted)" }}>
                            {monogram(l.company)}
                          </span>
                        )}
                        <span className="font-medium truncate" title={l.company}>{l.company}</span>
                      </div>
                    </td>

                    <td className={CELL}>
                      {/* Native select: a stage change is one click and one
                          request, which is the whole reason this view exists
                          next to a drag-and-drop board. */}
                      <select
                        value={l.status}
                        onChange={(e) => setStatus(l, e.target.value as Status)}
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium outline-none border cursor-pointer"
                        style={{ background: `${meta?.color ?? "#888"}1a`, color: meta?.color, borderColor: "transparent" }}
                      >
                        {STATUS_COLUMNS.map((c) => (
                          <option key={c.id} value={c.id} style={{ background: "var(--surface)", color: "var(--text)" }}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td className={CELL}>
                      {l.contact_name ? (
                        <div className="min-w-0">
                          <div className="truncate">{l.contact_name}</div>
                          {l.contact_role && <div className="truncate text-[10px]" style={{ color: "var(--faint)" }}>{l.contact_role}</div>}
                        </div>
                      ) : (
                        <span style={{ color: "var(--faint)" }}>—</span>
                      )}
                    </td>

                    <td className={CELL}>
                      {l.contact_email ? (
                        <a href={`mailto:${l.contact_email}`} className="truncate block" style={{ color: "var(--blue)" }} title={l.contact_email}>
                          {l.contact_email}
                        </a>
                      ) : (
                        <FindContact leadId={l.id} onFound={(addr) => apply({ ...l, contact_email: addr })} />
                      )}
                    </td>

                    <td className={CELL}>
                      {l.owner_name ? (
                        <span className="truncate">{l.owner_name}</span>
                      ) : (
                        <button
                          onClick={async () => { const u = await patch(l.id, { owner_name: name }); if (u) apply(u); }}
                          className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{ background: "var(--surface3)", color: "var(--muted)" }}
                        >
                          Claim
                        </button>
                      )}
                    </td>

                    <td className={`${CELL} whitespace-nowrap`} style={{ color: l.amount != null ? "#4ade80" : "var(--faint)" }}>
                      {l.amount != null ? `$${l.amount.toLocaleString()}` : "—"}
                    </td>

                    <td className={`${CELL} whitespace-nowrap`}>
                      {action?.kind === "followup" ? (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: "rgba(245,158,11,.12)", color: "#f59e0b" }}>
                          {action.quietDays}d quiet
                        </span>
                      ) : (
                        <span style={{ color: "var(--faint)" }}>{shortDate(l.last_activity_at ?? l.updated_at) || "—"}</span>
                      )}
                    </td>

                    <td className={CELL}><span className="truncate block" title={l.industry ?? ""}>{l.industry || <span style={{ color: "var(--faint)" }}>—</span>}</span></td>
                    <td className={CELL}><span className="truncate block" title={l.location ?? ""}>{l.location || <span style={{ color: "var(--faint)" }}>—</span>}</span></td>

                    <td className={CELL}>
                      <span className="text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap" style={{ background: "var(--surface3)", color: conn.color }}>
                        {conn.label}
                      </span>
                    </td>

                    <td className={`${CELL} whitespace-nowrap`} style={{ color: "var(--muted)" }}>{l.created_by_name || "—"}</td>
                    <td className={`${CELL} whitespace-nowrap`} style={{ color: "var(--faint)" }}>{shortDate(l.created_at)}</td>

                    <td className={CELL}>
                      <button
                        onClick={() => setEmailLead(l)}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium"
                        style={{ background: "var(--accent)", color: "#fff" }}
                      >
                        <Mail size={11} /> Draft
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {emailLead && <EmailModal lead={emailLead} onClose={() => setEmailLead(null)} />}
      {detail && (
        <LeadDetail
          lead={detail}
          onClose={() => setDetail(null)}
          onUpdated={(l) => { apply(l); setDetail(l); }}
        />
      )}
    </div>
  );
}

/**
 * The one action worth having inline: 101 of 110 rows have no address, and
 * "No email yet" is the filter this table is most useful for. Local state only
 * -- the route persists what it finds, so the value survives the next load.
 */
function FindContact({ leadId, onFound }: { leadId: string; onFound: (email: string) => void }) {
  const [state, setState] = useState<"idle" | "busy" | "none">("idle");

  if (state === "none") return <span className="text-[10px]" style={{ color: "var(--faint)" }}>none published</span>;

  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        setState("busy");
        try {
          const res = await fetch(`/api/leads/${leadId}/contact`, { method: "POST" });
          const data = await res.json();
          if (data.email) { onFound(data.email); setState("idle"); }
          else setState("none");
        } catch {
          setState("idle");
        }
      }}
      disabled={state === "busy"}
      className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded disabled:opacity-60"
      style={{ background: "var(--surface3)", color: "var(--muted)" }}
      title="Look for a published address on their own site"
    >
      {state === "busy" ? <Check size={10} className="dot-pulse" /> : <AtSign size={10} />} Find
    </button>
  );
}
