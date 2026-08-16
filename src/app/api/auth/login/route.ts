import { cookies } from "next/headers";
import { checkPassword, makeToken, COOKIE_NAME } from "@/lib/auth";

export async function POST(req: Request) {
  const { password, name } = await req.json().catch(() => ({}));
  if (!checkPassword(String(password ?? ""))) {
    return Response.json({ error: "Incorrect team password." }, { status: 401 });
  }
  const displayName = String(name ?? "").trim().slice(0, 40) || "Team member";
  const store = await cookies();
  store.set(COOKIE_NAME, makeToken(displayName), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return Response.json({ ok: true, name: displayName });
}
