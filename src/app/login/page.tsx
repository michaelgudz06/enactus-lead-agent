"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed");
        setLoading(false);
        return;
      }
      router.push("/agent");
    } catch {
      setError("Network error");
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <span className="inline-block w-1 h-7 rounded" style={{ background: "var(--gold)" }} />
          <span className="font-black tracking-widest text-lg" style={{ color: "var(--gold)" }}>
            ENACTUS SFU
          </span>
        </div>
        <div className="rounded-2xl border p-7 animate-in" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <h1 className="text-xl font-bold mb-1">Lead Agent</h1>
          <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
            Find sponsors, research them, and draft outreach.
          </p>
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>Your name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Michael"
                className="mt-1 w-full rounded-lg px-3 py-2.5 text-sm outline-none border focus:border-[var(--gold)]"
                style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
              />
            </div>
            <div>
              <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>Team password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="mt-1 w-full rounded-lg px-3 py-2.5 text-sm outline-none border focus:border-[var(--gold)]"
                style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
              />
            </div>
            {error && <p className="text-sm" style={{ color: "var(--accent)" }}>{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg py-2.5 text-sm font-semibold text-black disabled:opacity-60"
              style={{ background: "var(--gold)" }}
            >
              {loading ? "Entering…" : "Enter"}
            </button>
          </form>
        </div>
        <p className="text-center text-xs mt-4" style={{ color: "var(--faint)" }}>
          Shared team board · your name is used to attribute leads
        </p>
      </div>
    </main>
  );
}
