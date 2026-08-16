// Rows to CSV, for the export that is this database's only escape hatch.
//
// The point of this file is not convenience, it is survival: the board lives in
// one Neon project on one graduating student's personal account, and the last
// two Supabase projects behind this app vanished without warning. A CSV a
// successor can open in Excel is the copy that outlives the account.
//
// No imports on purpose -- selfcheck.ts runs it under
// `node --experimental-strip-types`. See run-events.ts for the same trade.

/**
 * One field, escaped.
 *
 * Quoting only when needed keeps the file readable, but the three characters
 * that force quotes are exactly the three that corrupt a whole sheet when
 * missed: a comma ends the field early, a newline ends the row early, and a
 * bare quote swallows the rest of the line. Postgres text columns hold all
 * three -- `why_fit` alone routinely contains commas.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s =
    value instanceof Date
      ? value.toISOString()
      : Array.isArray(value)
        ? value.join("; ")
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows to a CSV document, CRLF-terminated.
 *
 * Columns default to the union of every key present rather than the first
 * row's, so a lead missing an optional field cannot silently drop that column
 * for everybody. CRLF because RFC 4180 says so and because Excel on Windows is
 * the actual consumer here.
 */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}
