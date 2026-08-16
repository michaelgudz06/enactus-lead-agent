// The one hand-typed number in the app.
//
// Lived twice, byte for byte, in board/page.tsx and leads/page.tsx -- same
// question, same parse, same escape hatch. Two copies of a money rule is one
// copy too many: the board's and the list's idea of "is $1,200 valid" could
// drift apart without anything failing loudly, and the pipeline total is built
// out of whatever they let through.
//
// No imports, so the parse can be pinned in scripts/selfcheck.ts.

/**
 * Read a hand-typed CAD amount. Returns null for "leave it unset", which
 * covers cancel, blank, and anything that is not a whole non-negative number.
 *
 * null is deliberately NOT 0: an unvalued win and a $0 win are different facts,
 * and only one of them should count toward a pipeline total.
 */
export function parseAmount(raw: string | null | undefined): number | null {
  // Strip what people actually type -- "$1,200", " 1200 ". Everything else is
  // rejected rather than coerced: Number("12ab") is NaN, but Number("") is 0
  // and Number(" ") is 0, which is how a blank box becomes a booked $0.
  const cleaned = (raw ?? "").replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The prompt itself, so the wording cannot drift between the two surfaces. */
export function amountQuestion(company: string): string {
  return `What is ${company} worth in CAD? Whole dollars — leave blank if it is in-kind or not settled yet.`;
}
