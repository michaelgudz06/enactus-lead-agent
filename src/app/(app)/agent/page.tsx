"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, ArrowUp, Brain, History, Lightbulb, CircleDashed, CheckCircle2, AlertTriangle, ChevronDown } from "lucide-react";
import { useApp } from "@/components/AppShell";
import { useRun, Turn } from "@/components/RunProvider";
import { Lead, SearchRow } from "@/lib/types";
import LeadCard from "@/components/LeadCard";
import EmailModal from "@/components/EmailModal";

const EXAMPLES_SPONSOR = [
  "Catering & food companies in Burnaby that could sponsor student events",
  "SFU alumni-founded tech startups in Vancouver open to giving back",
  "Credit unions and banks in the Lower Mainland with community grant programs",
];
const EXAMPLES_SALES = [
  "Mid-size Vancouver construction firms that might need project management software",
  "Burnaby manufacturing companies expanding their operations this year",
  "BC startups that recently raised funding and are hiring ops roles",
];

export default function AgentPage() {
  const { mode } = useApp();
  // The run itself lives in RunProvider, mounted by the (app) layout, so that
  // navigating to the board does not unmount it and kill the stream.
  const { turns, setTurns, prompt, setPrompt, running, send: startRun } = useRun();
  const [history, setHistory] = useState<SearchRow[]>([]);
  const [emailLead, setEmailLead] = useState<Lead | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const examples = mode === "sales" ? EXAMPLES_SALES : EXAMPLES_SPONSOR;
  const last = turns[turns.length - 1];
  const awaitingAnswers = Boolean(last?.clarify && !running);

  useEffect(() => {
    fetch(`/api/searches?mode=${mode}`).then((r) => r.json()).then((d) => setHistory(d.searches || [])).catch(() => {});
  }, [mode, running]);

  // Follow the stream, but only while the reader is already at the bottom --
  // scrolling up to re-read an earlier lead must not get yanked back down.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  function send() {
    startRun(prompt, mode, awaitingAnswers);
  }

  // A rejected lead is deleted, not hidden: the agent saves every lead to the
  // board as it streams, so leaving it would put a lead the user just turned
  // down in Prospects.
  async function dismiss(turnIdx: number, id: string) {
    const mark = (fn: (d: string[]) => string[]) =>
      setTurns((ts) => ts.map((t, i) => (i === turnIdx ? { ...t, dismissed: fn(t.dismissed) } : t)));
    mark((d) => [...d, id]);
    const res = await fetch(`/api/leads/${id}`, { method: "DELETE" });
    if (!res.ok) mark((d) => d.filter((x) => x !== id));
  }

  return (
    <div className="h-full flex flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-7">
          {turns.length === 0 && (
            <div className="pt-6">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles size={18} style={{ color: "var(--gold)" }} />
                <h1 className="text-lg font-bold">Find sponsors</h1>
              </div>
              <p className="text-sm mb-4 ml-7" style={{ color: "var(--muted)" }}>
                Describe the kind of sponsor you want. The agent finds real Lower Mainland companies, checks for SFU ties,
                matches each to an Enactus project, and adds them to your board. Anything that isn’t a fit, hit ✕ and it’s gone.
              </p>

              <div className="flex flex-wrap gap-2">
                {examples.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => setPrompt(ex)}
                    className="text-xs px-3 py-1.5 rounded-full border text-left"
                    style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
                  >
                    {ex}
                  </button>
                ))}
              </div>

              {history.length > 0 && (
                <div className="mt-8">
                  <div className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
                    <History size={13} /> Recent searches
                  </div>
                  <div className="space-y-1.5">
                    {history.slice(0, 6).map((h) => (
                      <button key={h.id} onClick={() => setPrompt(h.prompt)} className="w-full text-left text-xs px-3 py-2 rounded-lg border flex items-center justify-between" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                        <span className="truncate" style={{ color: "var(--text)" }}>{h.prompt}</span>
                        <span className="shrink-0 ml-3" style={{ color: "var(--faint)" }}>{h.result_count} leads · {h.created_by_name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {turns.map((t, i) => (
            <div key={i} className="space-y-4">
              <div className="flex justify-end animate-in">
                <div className="rounded-2xl rounded-br-sm px-4 py-2.5 text-sm max-w-[80%] whitespace-pre-wrap" style={{ background: "var(--surface3)" }}>
                  {t.prompt}
                </div>
              </div>
              <AgentTurn
                turn={t}
                running={running && i === turns.length - 1}
                onEmail={setEmailLead}
                onDismiss={(id) => dismiss(i, id)}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="border-t" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
        <div className="max-w-3xl mx-auto px-5 py-3">
          <div className="rounded-2xl border p-2 flex items-end gap-2" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={
                awaitingAnswers ? "Answer the questions above…"
                : mode === "sales" ? "Describe the customers you want to find…"
                : "Describe the sponsors you want to find…"
              }
              rows={2}
              className="grow-text flex-1 bg-transparent outline-none text-sm resize-none px-2 py-1.5"
            />
            <button
              onClick={send}
              disabled={running || !prompt.trim()}
              className="grid place-items-center w-9 h-9 rounded-xl text-black disabled:opacity-40 shrink-0"
              style={{ background: "var(--gold)" }}
              title="Send"
            >
              <ArrowUp size={17} />
            </button>
          </div>
          <div className="text-[11px] mt-1.5 text-center" style={{ color: "var(--faint)" }}>
            {running ? "Agent is working…" : "Enter to send · Shift + Enter for a new line"}
          </div>
        </div>
      </div>

      {emailLead && <EmailModal lead={emailLead} onClose={() => setEmailLead(null)} />}
    </div>
  );
}

function AgentTurn({
  turn, running, onEmail, onDismiss,
}: {
  turn: Turn;
  running: boolean;
  onEmail: (lead: Lead) => void;
  onDismiss: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const reasonRef = useRef<HTMLDivElement>(null);
  const showReasoning = open || running;

  useEffect(() => {
    if (reasonRef.current) reasonRef.current.scrollTop = reasonRef.current.scrollHeight;
  }, [turn.reasoning, showReasoning]);

  const visible = turn.leads.filter((l) => !turn.dismissed.includes(l.id));
  const dropped = turn.dismissed.length;

  return (
    <div className="flex gap-3 animate-in">
      <span className="grid place-items-center w-7 h-7 rounded-full shrink-0 mt-0.5" style={{ background: "var(--surface3)" }}>
        <Sparkles size={14} style={{ color: "var(--gold)" }} />
      </span>

      <div className="min-w-0 flex-1 space-y-3">
        {/* Activity */}
        <div className="space-y-2">
          {turn.steps.map((s, i) => {
            const isLast = i === turn.steps.length - 1 && running;
            return (
              <div key={i} className="flex items-start gap-2 text-xs animate-in">
                {isLast
                  ? <CircleDashed size={14} className="shrink-0 mt-0.5 dot-pulse" style={{ color: "var(--gold)" }} />
                  : <CheckCircle2 size={14} className="shrink-0 mt-0.5" style={{ color: "var(--green)" }} />}
                <span style={{ color: isLast ? "var(--text)" : "var(--muted)" }}>{s.message}</span>
              </div>
            );
          })}
          {turn.steps.length === 0 && running && <div className="text-xs" style={{ color: "var(--muted)" }}>Starting…</div>}
        </div>

        {/* Thinking */}
        {turn.reasoning && (
          <div>
            <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[11px] font-medium" style={{ color: "var(--faint)" }}>
              <Brain size={12} /> Thinking <ChevronDown size={12} className={showReasoning ? "rotate-180" : ""} />
            </button>
            {showReasoning && (
              <div ref={reasonRef} className="mt-1.5 text-[11px] leading-relaxed whitespace-pre-wrap max-h-56 overflow-y-auto reason-scroll p-2.5 rounded-lg" style={{ background: "var(--surface)", color: "var(--muted)" }}>
                {turn.reasoning}
                {running && <span className="dot-pulse">▋</span>}
              </div>
            )}
          </div>
        )}

        {turn.similar && (
          <div className="rounded-xl border p-3 flex gap-2.5" style={{ background: "rgba(245,200,66,.08)", borderColor: "rgba(245,200,66,.35)" }}>
            <History size={16} style={{ color: "var(--gold)" }} className="shrink-0 mt-0.5" />
            <div className="text-xs">
              <div style={{ color: "var(--text)" }}>{turn.similar.message}</div>
              <div className="mt-1 flex items-start gap-1" style={{ color: "var(--muted)" }}>
                <Lightbulb size={13} className="shrink-0 mt-0.5" style={{ color: "var(--gold)" }} /> {turn.similar.suggestion}
              </div>
            </div>
          </div>
        )}

        {turn.clarify && (
          <div className="rounded-xl border p-3.5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <div className="text-sm font-semibold mb-2">A couple quick questions to sharpen the search</div>
            <ul className="text-xs space-y-1" style={{ color: "var(--muted)" }}>
              {turn.clarify.map((q, i) => <li key={i}>• {q}</li>)}
            </ul>
            <div className="text-[11px] mt-2.5" style={{ color: "var(--faint)" }}>Reply below and the agent picks up where it left off.</div>
          </div>
        )}

        {turn.error && (
          <div className="rounded-xl border p-3 flex gap-2 text-xs" style={{ background: "rgba(230,57,70,.08)", borderColor: "rgba(230,57,70,.35)", color: "var(--text)" }}>
            <AlertTriangle size={15} style={{ color: "var(--accent)" }} className="shrink-0 mt-0.5" /> {turn.error}
          </div>
        )}

        {turn.leads.length > 0 && (
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold">
              {visible.length} lead{visible.length !== 1 ? "s" : ""}
              {dropped > 0 && <span className="font-normal" style={{ color: "var(--faint)" }}> · {dropped} dismissed</span>}
            </span>
            {turn.done && visible.length > 0 && <a href="/board" style={{ color: "var(--gold)" }}>In Prospects → View board</a>}
          </div>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          {/* The page still calls it dismissing (it keeps the "N dismissed"
              counter); the card only knows it is a delete, because that is what
              DELETE /api/leads/:id does on both pages. */}
          {visible.map((l) => <LeadCard key={l.id} lead={l} onEmail={onEmail} onDelete={onDismiss} />)}
        </div>

        {running && turn.leads.length === 0 && !turn.clarify && (
          <div className="grid sm:grid-cols-2 gap-3">
            {[0, 1].map((i) => <div key={i} className="h-40 rounded-xl shimmer" />)}
          </div>
        )}

        {turn.done && turn.leads.length === 0 && !turn.clarify && !turn.error && (
          <div className="rounded-xl border p-4 text-sm" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <div className="font-semibold mb-1">No sponsors matched this one.</div>
            <div style={{ color: "var(--muted)" }}>
              This often happens when a search surfaces student clubs or membership groups, which the agent skips on purpose. Try naming a concrete business type or industry, for example “credit unions with community grants”, “catering companies in Burnaby”, or “sustainable packaging companies”.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
