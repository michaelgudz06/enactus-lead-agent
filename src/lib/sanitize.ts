// Enforces Michael's outreach style rules on any model-generated email copy.
// Hard rule: no em dashes (or en dashes used as em dashes). Keep it human and clean.

export function stripEmDashes(input: string): string {
  return input
    // em dash and en dash -> comma or nothing depending on spacing
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*–\s*/g, ", ")
    // stray double hyphens sometimes used as em dashes
    .replace(/\s*--\s*/g, ", ")
    // collapse any accidental ", ," produced above
    .replace(/,\s*,/g, ",")
    // tidy space before punctuation
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
