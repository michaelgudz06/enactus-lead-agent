// What a lead needs next, derived rather than typed.
//
// The obvious design is a due-date column and a reminder the volunteer sets.
// This app's own data argues against it: across 110 leads there are zero
// senders, zero templates and zero hand-written notes -- every field that has
// ever depended on somebody remembering to fill it in is empty. So the nag is
// computed from two things the app already stamps by itself: the stage a card
// is in, and how long it has been silent.
//
// No imports on purpose: scripts/selfcheck.ts runs this under
// `node --experimental-strip-types`, which cannot resolve `@/lib/types`. The
// lead therefore arrives structurally -- the same trade email-lint.ts and
// run-events.ts make.

export interface ActionableLead {
  status: string;
  amount?: number | null;
  /** greatest(updated_at, newest activity), when the caller computed it. */
  last_activity_at?: string | null;
  updated_at?: string | null;
}

export interface NextAction {
  label: string;
  kind: "followup" | "amount";
  /** Days of silence behind a followup, for sorting a "needs attention" list. */
  quietDays: number;
}

const DAY = 86_400_000;
const FOLLOW_UP_DAYS = 7;
const REPLY_DAYS = 5;

/**
 * Days since anything happened to this lead.
 *
 * last_activity_at is preferred because a logged call or a created draft is a
 * real touch, while updated_at also moves for machine writes. It is optional,
 * so a lead that arrived from anywhere but the board's GET falls back rather
 * than reading as infinitely stale and nagging on every card.
 */
export function quietDaysFor(lead: ActionableLead, now: number): number {
  const stamp = lead.last_activity_at ?? lead.updated_at;
  const t = stamp ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / DAY));
}

/**
 * The one thing to do about this lead, or null when the answer is "nothing".
 *
 * Deliberately silent for prospects and researched: the card already carries
 * their next action as a button (Find contact, Draft email), and a chip on all
 * 107 prospects would be noise that teaches the team to ignore chips.
 * closed_lost is silent because it is terminal.
 */
export function nextAction(lead: ActionableLead, now: number): NextAction | null {
  const quiet = quietDaysFor(lead, now);

  if (lead.status === "outreach_sent" && quiet >= FOLLOW_UP_DAYS) {
    return { label: `Follow up · quiet ${quiet}d`, kind: "followup", quietDays: quiet };
  }
  if (lead.status === "in_conversation" && quiet >= REPLY_DAYS) {
    return { label: `Reply due · quiet ${quiet}d`, kind: "followup", quietDays: quiet };
  }
  // A win with no number on it cannot be counted, and the total on the board is
  // wrong by exactly that much until someone says what it was worth.
  if (lead.status === "closed_won" && (lead.amount === null || lead.amount === undefined)) {
    return { label: "Record amount", kind: "amount", quietDays: quiet };
  }
  return null;
}
