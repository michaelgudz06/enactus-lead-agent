import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Server-only Postgres access (Neon). The HTTP driver is one round-trip per
// query with no pool to manage, which suits short-lived serverless routes and
// the 60s Hobby function cap. Created lazily on first use so production builds
// don't need DATABASE_URL present during the build step.
let _sql: NeonQueryFunction<false, false> | null = null;

export function db(): NeonQueryFunction<false, false> {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  _sql = neon(url);
  return _sql;
}

export function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * SET clause for a PATCH body, built from an allow-list.
 *
 * Column names come only from `editable`, never from the request, so they are
 * safe to interpolate. Values always go through $n placeholders. `casts` names
 * the columns Postgres cannot infer a type for on its own (text[], boolean).
 */
export function setClause(
  body: Record<string, unknown>,
  editable: Set<string>,
  casts: Record<string, string> = {}
): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (!editable.has(k)) continue;
    values.push(v);
    sets.push(`${k} = $${values.length}${casts[k] ?? ""}`);
  }
  sets.push("updated_at = now()");
  return { sets, values };
}
