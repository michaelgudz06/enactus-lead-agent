"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AgentEvent, Lead, Mode } from "@/lib/types";
import { applyEvent, newTurn, RunTurn, takeLines } from "@/lib/run-events";

/**
 * The agent run, owned one level above the page that starts it.
 *
 * Every piece of run state used to live in `useState` on the agent page, so
 * navigating to the board unmounted the page and took the reader loop with it --
 * the run died the moment you went to look at the leads it was producing. This
 * component is mounted by `src/app/(app)/layout.tsx`, which wraps both routes.
 * Layouts do not re-render when navigating between the routes below them, so the
 * run and its reader stay alive while the student moves between the two.
 *
 * What this is NOT: durable. The fetch is the browser's own request, so a
 * refresh, a closed tab or a dropped connection still ends it. Surviving those
 * needs a job that outlives the request, which is a much larger change. The
 * server-side run does keep going either way -- `runAgent` writes each lead to
 * the board as it goes, so leads already found are on the board regardless.
 */

export type Turn = RunTurn<Lead>;

interface RunCtx {
  turns: Turn[];
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>;
  prompt: string;
  setPrompt: (v: string) => void;
  running: boolean;
  /** True once a run has been started in this session, for the board's refresh. */
  leadSignal: number;
  send: (text: string, mode: Mode, awaitingAnswers: boolean) => void;
}

const Ctx = createContext<RunCtx | null>(null);

export function useRun(): RunCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRun must be used inside RunProvider");
  return v;
}

export default function RunProvider({ children }: { children: React.ReactNode }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [leadSignal, setLeadSignal] = useState(0);

  // The search the agent is working on. Clarifying answers are a reply in the
  // transcript, but the API still needs the question they answer.
  const askedRef = useRef("");
  // Read synchronously by send() so two clicks in one tick cannot both start a
  // reader; `running` alone is a render behind and would let the second through.
  const busy = useRef(false);

  const run = useCallback(async (mode: Mode, answers?: string) => {
    busy.current = true;
    setRunning(true);
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: askedRef.current, mode, answers, skipClarify: Boolean(answers) }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { lines, rest } = takeLines(buf);
        buf = rest;
        for (const line of lines) {
          let ev: AgentEvent;
          // A line that is not JSON costs that line and nothing else.
          try { ev = JSON.parse(line) as AgentEvent; } catch { continue; }
          setTurns((ts) => applyEvent(ts, ev));
          // A lead is emitted after the insert has been attempted, so this is
          // the earliest honest moment to tell the board to read again.
          if (ev.type === "lead" || ev.type === "done") setLeadSignal((n) => n + 1);
        }
      }
    } catch (e) {
      setTurns((ts) => applyEvent(ts, { type: "error", message: (e as Error).message }));
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }, []);

  const send = useCallback((text: string, mode: Mode, awaitingAnswers: boolean) => {
    const t = text.trim();
    if (!t || busy.current) return;
    setPrompt("");
    setTurns((ts) => [...ts, newTurn<Lead>(t)]);
    if (awaitingAnswers) void run(mode, t);
    else { askedRef.current = t; void run(mode); }
  }, [run]);

  return (
    <Ctx.Provider value={{ turns, setTurns, prompt, setPrompt, running, leadSignal, send }}>
      {children}
    </Ctx.Provider>
  );
}
