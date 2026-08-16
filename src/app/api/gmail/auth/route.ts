import { cookies } from "next/headers";
import { getSession, signCookie } from "@/lib/auth";
import { authUrl, hasGoogleConfig } from "@/lib/gmail";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.redirect(new URL("/login", process.env.APP_URL || "http://localhost:3000"));
  if (!hasGoogleConfig()) {
    return new Response(
      "Gmail is not connected yet. Add GOOGLE_CLIENT_SECRET (and confirm the redirect URI) to enable one-click Gmail drafts. Until then, use ‘Open in Gmail’.",
      { status: 200, headers: { "Content-Type": "text/plain" } }
    );
  }
  const state = crypto.randomBytes(16).toString("hex");
  const store = await cookies();
  store.set("gmail_state", signCookie({ state }), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  return Response.redirect(authUrl(state));
}
