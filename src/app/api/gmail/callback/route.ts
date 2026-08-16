import { cookies } from "next/headers";
import { readCookie, signCookie } from "@/lib/auth";
import { exchangeCode, GMAIL_COOKIE } from "@/lib/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const base = () => process.env.APP_URL || "http://localhost:3000";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const store = await cookies();
  const saved = readCookie<{ state: string }>(store.get("gmail_state")?.value);
  if (!code || !state || !saved || saved.state !== state) {
    return Response.redirect(new URL("/board?gmail=error", base()));
  }

  try {
    const tokens = await exchangeCode(code);
    store.set(GMAIL_COOKIE, signCookie(tokens), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 60,
    });
    store.delete("gmail_state");
    return Response.redirect(new URL("/board?gmail=connected", base()));
  } catch {
    return Response.redirect(new URL("/board?gmail=error", base()));
  }
}
