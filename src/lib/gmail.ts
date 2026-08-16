// Per-browser Gmail connection. Each teammate connects their own Google account.
// Tokens live in a signed, httpOnly cookie (never exposed to JS) -- the same
// signCookie/readCookie pair the session cookie uses, in auth.ts.

export const GMAIL_COOKIE = "gmail_tokens";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

export interface GmailTokens {
  access_token: string;
  refresh_token?: string;
  expiry: number; // epoch ms
}

export function hasGoogleConfig(): boolean {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  return Boolean(id && secret && !id.startsWith("REPLACE") && !secret.startsWith("REPLACE"));
}

export function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<GmailTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return { access_token: d.access_token, refresh_token: d.refresh_token, expiry: Date.now() + (d.expires_in ?? 3600) * 1000 };
}

export async function ensureAccessToken(tokens: GmailTokens): Promise<GmailTokens> {
  if (tokens.expiry > Date.now() + 60_000) return tokens;
  if (!tokens.refresh_token) throw new Error("Gmail session expired. Reconnect Gmail.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("Could not refresh Gmail token. Reconnect Gmail.");
  const d = await res.json();
  return { access_token: d.access_token, refresh_token: tokens.refresh_token, expiry: Date.now() + (d.expires_in ?? 3600) * 1000 };
}

// Header values are joined with CRLF below, so a newline inside one ends the
// header and starts another. `to` and `subject` originate from lead data the
// model wrote, which makes this a trust boundary: an address containing
// "\r\nBcc:" would add recipients to a draft the user is about to send.
const headerSafe = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export async function createDraft(accessToken: string, to: string, subject: string, body: string): Promise<string> {
  const cleanTo = headerSafe(to);
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(cleanTo)) {
    throw new Error(`Refusing to draft: "${to}" is not a valid email address.`);
  }
  const mime = [
    `To: ${cleanTo}`,
    `Subject: ${headerSafe(subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
    "",
    body,
  ].join("\r\n");
  const raw = Buffer.from(mime).toString("base64url");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
  });
  if (!res.ok) throw new Error(`Gmail draft failed: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return d.id as string;
}
