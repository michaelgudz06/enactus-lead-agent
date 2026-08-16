// How one streamed agent event changes the transcript.
//
// Split out of the agent page so the run can be owned by something that outlives
// it (see RunProvider) and so the folding itself is testable without a renderer.
// A client-side navigation is nothing more than a subscriber going away, so a
// reducer that never touches React is the part worth pinning.
//
// No imports on purpose: scripts/selfcheck.ts runs this under
// `node --experimental-strip-types`, which cannot resolve `@/lib/types`. The
// lead type therefore arrives as a type parameter rather than an import -- the
// folding never inspects a lead, it only appends one. Same trade email-lint.ts
// makes with its constants.

export interface RunStep {
  step: string;
  message: string;
}

/**
 * One run of the agent, rendered as one message in the transcript. Everything a
 * run streams belongs to the turn that produced it, so scrolling back shows what
 * each answer was built from.
 */
export interface RunTurn<L> {
  prompt: string;
  steps: RunStep[];
  reasoning: string;
  similar: { message: string; suggestion: string } | null;
  clarify: string[] | null;
  leads: L[];
  dismissed: string[];
  error: string;
  done: boolean;
}

/** Structurally the same as AgentEvent in types.ts, minus the import. */
export type RunEvent<L> =
  | { type: "status"; step: string; message: string }
  | { type: "reasoning"; text: string }
  | { type: "similar"; message: string; suggestion: string; pastPrompt?: string }
  | { type: "clarify"; questions: string[] }
  | { type: "lead"; lead: L }
  | { type: "done"; count?: number; searchId?: string | null }
  | { type: "error"; message: string };

export const newTurn = <L>(prompt: string): RunTurn<L> => ({
  prompt,
  steps: [],
  reasoning: "",
  similar: null,
  clarify: null,
  leads: [],
  dismissed: [],
  error: "",
  done: false,
});

/**
 * Fold one event into the transcript, always onto the newest turn.
 *
 * Total by construction: an event shape this build does not know costs nothing
 * rather than ending the run, which is the rule the rest of the pipeline reads
 * model output under. An event arriving with no turn to land on is likewise
 * dropped instead of throwing -- the run is server-side and cannot be recalled,
 * so a client that has lost its transcript must still let it finish.
 *
 * An `error` annotates the turn and never discards the leads already in it:
 * those are rows the agent has already written to the board, not a draft.
 */
export function applyEvent<L>(turns: RunTurn<L>[], ev: RunEvent<L>): RunTurn<L>[] {
  if (!turns.length) return turns;
  const i = turns.length - 1;
  const t = turns[i];
  const patch = (next: Partial<RunTurn<L>>): RunTurn<L>[] => {
    const copy = turns.slice();
    copy[i] = { ...t, ...next };
    return copy;
  };

  switch (ev.type) {
    case "status":
      return patch({ steps: [...t.steps, { step: ev.step, message: ev.message }] });
    case "reasoning":
      return patch({ reasoning: t.reasoning + ev.text });
    case "similar":
      return patch({ similar: { message: ev.message, suggestion: ev.suggestion } });
    case "clarify":
      return patch({ clarify: ev.questions });
    case "lead":
      return patch({ leads: [...t.leads, ev.lead] });
    case "done":
      return patch({ done: true });
    case "error":
      return patch({ error: ev.message });
    default:
      return turns;
  }
}

/**
 * Split a streamed chunk into whole NDJSON lines plus the remainder.
 *
 * The remainder matters: a chunk boundary lands mid-line often enough that
 * parsing what arrived and discarding the tail loses roughly one lead per run.
 */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim()), rest };
}
