"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { useApp } from "@/components/AppShell";
import { useRun } from "@/components/RunProvider";
import { Lead, Status, STATUS_COLUMNS } from "@/lib/types";
import { amountQuestion, parseAmount } from "@/lib/amount";
import { nextAction } from "@/lib/next-action";
import LeadCard from "@/components/LeadCard";
import EmailModal from "@/components/EmailModal";
import LeadDetail from "@/components/LeadDetail";

export default function BoardPage() {
  const { mode } = useApp();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<Status | null>(null);
  const [emailLead, setEmailLead] = useState<Lead | null>(null);
  const [detailLead, setDetailLead] = useState<Lead | null>(null);
  const [warning, setWarning] = useState("");
  // Read once per load rather than during render: the follow-up thresholds are
  // whole days, so re-reading the clock on every render would change nothing
  // except make the render impure. 0 until the first load, which is what keeps
  // the server-rendered markup free of a time-dependent chip.
  const [now, setNow] = useState(0);
  const pressAt = useRef({ x: 0, y: 0 });
  // The agent may be running on the other tab; leadSignal ticks when it has
  // written one.
  const { leadSignal } = useRun();

  async function load() {
    setLoading(true);
    const res = await fetch(`/api/leads?mode=${mode}`);
    const data = await res.json();
    setLeads(data.leads || []);
    setNow(Date.now());
    if (data.warning) setWarning(data.warning);
    setLoading(false);
  }

  // The mid-run re-read. Deliberately not load(): the board is already on
  // screen, and swapping it for the skeleton on every arriving lead is worse
  // than the row showing up a moment late. Touching no state before its first
  // await is also what keeps the effect below clear of the synchronous-setState
  // rule.
  async function refresh() {
    const res = await fetch(`/api/leads?mode=${mode}`);
    const data = await res.json();
    setLeads(data.leads || []);
    setNow(Date.now());
  }

  /* eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect --
     mode is the only real trigger, and load()'s one synchronous setState sets
     `loading` to the value it already holds on mount. */
  useEffect(() => { load(); }, [mode]);

  // A run started on the agent tab keeps going now that it is owned by the
  // layout, so its leads land in the database while this board is on screen.
  // Skips the first render, where the effect above is already loading.
  //
  // The set-state rule counts any call to a function that sets state, without
  // looking at whether it does so before its first await -- refresh() does not,
  // so there is no synchronous render cascade here. Fetching in response to a
  // counter is the intended shape; the rule cannot see the difference.
  /* eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- leadSignal is the trigger; refresh() sets state only after its await */
  useEffect(() => { if (leadSignal) void refresh(); }, [leadSignal]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((l) =>
      [l.company, l.industry, l.description, l.why_fit, l.contact_name].filter(Boolean).join(" ").toLowerCase().includes(q)
    );
  }, [leads, query]);

  // Built from STATUS_COLUMNS rather than a hand-written record, so adding a
  // stage to types.ts is the whole change -- the previous literal silently
  // dropped any lead whose stage was not one of its five keys into Prospects.
  const byStatus = useMemo(() => {
    const map = Object.fromEntries(STATUS_COLUMNS.map((c) => [c.id, [] as Lead[]])) as Record<Status, Lead[]>;
    for (const l of filtered) (map[l.status] ?? map.prospects).push(l);
    return map;
  }, [filtered]);

  // The three numbers a VP External gets asked for, computed in code from
  // stored integers -- never a figure a model wrote. `unvalued` is shown rather
  // than hidden because a total that quietly omits four wins is worse than one
  // that admits it is incomplete.
  const stats = useMemo(() => {
    const won = leads.filter((l) => l.status === "closed_won");
    return {
      wonTotal: won.reduce((s, l) => s + (l.amount ?? 0), 0),
      wonCount: won.length,
      unvalued: won.filter((l) => l.amount == null).length,
      due: now ? leads.filter((l) => nextAction(l, now)?.kind === "followup").length : 0,
    };
  }, [leads, now]);

  async function moveTo(id: string, status: Status) {
    const prev = leads;
    const lead = leads.find((l) => l.id === id);
    const body: { status: Status; amount?: number } = { status };

    // The only hand-typed value in the app, asked at the one moment it is known
    // and the volunteer's hand is already on the card. A cancel, a blank, or
    // anything that is not a whole dollar amount leaves it unset and the card
    // still moves -- a drag must never be held hostage to a number.
    if (status === "closed_won" && lead && lead.amount == null) {
      const n = parseAmount(window.prompt(amountQuestion(lead.company)));
      if (n !== null) body.amount = n;
    }

    setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, ...body } : l)));
    const res = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return setLeads(prev);
    // closed_at and owner_name are stamped by the route, so the row it returns
    // is the only one that knows them.
    const data = await res.json().catch(() => ({}));
    if (data.lead) setLeads((ls) => ls.map((l) => (l.id === id ? data.lead : l)));
  }

  async function del(id: string) {
    const prev = leads;
    setLeads((ls) => ls.filter((l) => l.id !== id));
    const res = await fetch(`/api/leads/${id}`, { method: "DELETE" });
    if (!res.ok) setLeads(prev);
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 border w-full max-w-xs" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <Search size={14} style={{ color: "var(--faint)" }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search leads…" className="bg-transparent outline-none text-sm w-full" />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: "var(--faint)" }}>{filtered.length} {filtered.length === 1 ? "lead" : "leads"}</span>
          {stats.wonCount > 0 && (
            <span className="text-xs font-semibold" style={{ color: "#4ade80" }}>
              ${stats.wonTotal.toLocaleString()} won
              {stats.unvalued > 0 && (
                <span className="font-normal" style={{ color: "var(--faint)" }}>
                  {" "}· {stats.unvalued} unvalued
                </span>
              )}
            </span>
          )}
          {stats.due > 0 && (
            <span className="text-xs font-semibold" style={{ color: "#f59e0b" }}>
              {stats.due} need follow-up
            </span>
          )}
          <button onClick={() => load()} className="p-1.5 rounded-lg hover:bg-[var(--surface3)]" style={{ color: "var(--muted)" }} title="Refresh">
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {warning && (
        <div className="mx-5 mt-3 text-xs rounded-lg px-3 py-2" style={{ background: "rgba(230,57,70,.1)", color: "var(--text)" }}>
          {warning} — leads can’t load until DATABASE_URL is set in the environment.
        </div>
      )}

      {!loading && !warning && leads.length === 0 && (
        <div className="mx-5 mt-4 rounded-xl border p-4 flex items-center gap-3 animate-in" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <div className="text-sm">
            <div className="font-semibold">Your pipeline is empty.</div>
            <div style={{ color: "var(--muted)" }}>
              Head to the{" "}
              <a href="/agent" className="font-medium" style={{ color: "var(--gold)" }}>Agent</a>{" "}
              tab and describe the sponsors you want. Found leads land here in Prospects, and you drag them across the stages as you go.
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-x-auto">
        <div className="flex gap-3 p-5 min-h-full" style={{ minWidth: "max-content" }}>
          {STATUS_COLUMNS.map((col) => {
            const items = byStatus[col.id] || [];
            const isOver = overCol === col.id;
            return (
              <div
                key={col.id}
                onDragOver={(e) => { e.preventDefault(); setOverCol(col.id); }}
                onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
                onDrop={() => { if (dragId) moveTo(dragId, col.id); setDragId(null); setOverCol(null); }}
                className="w-[300px] shrink-0 rounded-2xl border flex flex-col transition-colors"
                style={{ background: isOver ? "var(--surface2)" : "var(--surface)", borderColor: isOver ? col.color : "var(--border)" }}
              >
                <div className="flex items-center justify-between px-3.5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: col.color }} />
                    <span className="text-sm font-semibold">{col.label}</span>
                  </div>
                  <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--surface3)", color: "var(--muted)" }}>{items.length}</span>
                </div>
                <div className="flex-1 p-2.5 space-y-2.5 overflow-y-auto" style={{ maxHeight: "calc(100vh - 190px)" }}>
                  {loading ? (
                    <>
                      <div className="h-32 rounded-xl shimmer" />
                      <div className="h-32 rounded-xl shimmer" />
                    </>
                  ) : items.length === 0 ? (
                    <div className="text-xs text-center py-8" style={{ color: "var(--faint)" }}>Drop leads here</div>
                  ) : (
                    items.map((l) => (
                      // Opening the panel is wired here rather than in LeadCard
                      // because the agent page uses the same card without a
                      // board to open into.
                      <div
                        key={l.id}
                        onPointerDown={(e) => { pressAt.current = { x: e.clientX, y: e.clientY }; }}
                        onClick={(e) => {
                          // A finished drag still lands as a click in some
                          // browsers, so travel is what separates the two --
                          // cheaper and less leaky than a drag-state flag.
                          if (Math.hypot(e.clientX - pressAt.current.x, e.clientY - pressAt.current.y) > 4) return;
                          // The card's own buttons and links keep their jobs.
                          if ((e.target as HTMLElement).closest("button, a")) return;
                          setDetailLead(l);
                        }}
                      >
                        <LeadCard
                          lead={l}
                          now={now}
                          draggable
                          onDragStart={() => setDragId(l.id)}
                          onEmail={setEmailLead}
                          onDelete={del}
                        />
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {emailLead && <EmailModal lead={emailLead} onClose={() => setEmailLead(null)} />}
      {detailLead && (
        <LeadDetail
          lead={detailLead}
          onClose={() => setDetailLead(null)}
          onUpdated={(l) => {
            setLeads((ls) => ls.map((x) => (x.id === l.id ? l : x)));
            setDetailLead(l);
          }}
        />
      )}
    </div>
  );
}
