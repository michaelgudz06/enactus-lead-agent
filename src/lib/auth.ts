import { cookies } from "next/headers";
import crypto from "crypto";
import { hasDatabaseUrl } from "./db";

// Lightweight shared-password auth. One team password gates the whole app.
// A signed cookie carries only the user's chosen display name (for attribution).
// No PII, no external auth provider, no SMTP.

const COOKIE = "enactus_session";
const SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";

export interface Session {
  name: string;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

// Every signed cookie in the app goes through this pair: the session token and
// the Gmail token blob had separate, identical copies of it.
export function signCookie(data: unknown): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readCookie<T>(value: string | undefined): T | null {
  if (!value) return null;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  if (sign(payload) !== sig) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as T;
  } catch {
    return null;
  }
}

export const makeToken = (name: string): string => signCookie({ name, t: Date.now() });

function verifyToken(token: string | undefined): Session | null {
  const data = readCookie<{ name?: unknown }>(token);
  return typeof data?.name === "string" ? { name: data.name } : null;
}

// The one constant-time secret compare in the app -- team password and backup
// token are the same rule. An unset or empty `expected` authorises nobody, and
// the length check stays ahead of timingSafeEqual, which throws on a mismatch.
export function secretMatches(input: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const checkPassword = (input: string): boolean =>
  secretMatches(input, process.env.APP_TEAM_PASSWORD);

export const COOKIE_NAME = COOKIE;

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return verifyToken(store.get(COOKIE)?.value);
}

/**
 * The preamble every data route repeated by hand: signed-in, database
 * configured, and any throw reported as a 500 with its message.
 *
 * `noDb` is the body a read route answers with when DATABASE_URL is absent --
 * the board wants an empty list and a warning banner, not an error. Omit it and
 * a missing database is a 400, which is what the write routes want.
 */
export function route<A extends unknown[]>(
  fn: (session: Session, ...args: A) => Promise<Response>,
  noDb?: object
) {
  return async (...args: A): Promise<Response> => {
    const session = await getSession();
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!hasDatabaseUrl()) {
      return noDb
        ? Response.json({ ...noDb, warning: "DATABASE_URL missing" })
        : Response.json({ error: "DATABASE_URL missing" }, { status: 400 });
    }
    try {
      return await fn(session, ...args);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  };
}
