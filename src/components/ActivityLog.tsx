"use client";

import { useEffect, useState } from "react";
import { StickyNote, Phone, Mail, ArrowRight, AtSign } from "lucide-react";
import { STATUS_COLUMNS, Status } from "@/lib/types";
import { useApp } from "./AppShell";

export interface Activity {
  id: string;
  lead_id: string;
  kind: "note" | "call" | "email" | "status_change" | "contact_found";
  body: string | null;
  meta: { from?: string; to?: string } | null;
  actor_name: string | null;
  created_at: string;
}

const ICONS = {
  note: StickyNote,
  call: Phone,
  email: Mail,
  status_change: ArrowRight,
  contact_found: AtSign,
};

const KIND_COLOR: Record<Activity["kind"], string> = {
  note: "var(--muted)",
  call: "var(--green)",
  email: "var(--blue)",
  status_change: "var(--gold)",
  contact_found: "var(--purple)",
};

const statusLabel = (id?: string) =>
  STATUS_COLUMNS.find((c) => c.id === (id as Status))?.label ?? id ?? "—";

// Relative for the window a person actually remembers, absolute past that. A
// date library would be ~15kB to render six strings.
function ago(iso: string): string {
  const then = new Date(iso);
  const min = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function line(a: Activity): string {
  if (a.kind === "status_change") {
    return `${a.actor_name ?? "Someone"} moved ${statusLabel(a.meta?.from)} → ${statusLabel(a.meta?.to)}`;
  }
  return a.body ?? "";
}

export default function ActivityLog({ leadId }: { leadId: string }) {
  const { name } = useApp();
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<"note" | "call" | "email">("note");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  // A promise chain rather than an awaited async helper: every setState then
  // sits in a callback, which is what react-hooks/set-state-in-effect wants.
  // `loading` starts true, so nothing has to set it on the way in.
  useEffect(() => {
    let alive = true;
    fetch(`/api/leads/${leadId}/activity`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load activity");
        return (data.activities || []) as Activity[];
      })
      .then((rows) => { if (alive) setItems(rows); })
      .catch((e: Error) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [leadId]);

  async function save() {
    const text = body.trim();
    if (!text || saving) return;
    setSaving(true);

    // Prepend before the round-trip: writing a note is the reason this panel
    // exists, and it has to feel instant. The temp row is swapped for the
    // server's (real id, real timestamp) on success and dropped on failure.
    const tempId = `temp-${Date.now()}`;
    const optimistic: Activity = {
      id: tempId,
      lead_id: leadId,
      kind,
      body: text,
      meta: null,
      actor_name: name,
      created_at: new Date().toISOString(),
    };
    setItems((a) => [optimistic, ...a]);
    setBody("");

    try {
      const res = await fetch(`/api/leads/${leadId}/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, body: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setItems((a) => a.map((x) => (x.id === tempId ? data.activity : x)));
      setError("");
    } catch (e) {
      setItems((a) => a.filter((x) => x.id !== tempId));
      setBody(text);
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="rounded-xl border p-3" style={{ background: "var(--surface2)", borderColor: "var(--border)" }}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
          rows={2}
          placeholder="Log a note, a call, an email…"
          className="w-full bg-transparent outline-none text-sm resize-none grow-text"
        />
        <div className="mt-2 flex items-center gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            className="text-xs rounded-lg px-2 py-1.5 outline-none border"
            style={{ background: "var(--surface3)", borderColor: "var(--border)", color: "var(--muted)" }}
          >
            <option value="note">Note</option>
            <option value="call">Call</option>
            <option value="email">Email logged</option>
          </select>
          <button
            onClick={save}
            disabled={!body.trim() || saving}
            className="ml-auto px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
            style={{ background: "var(--accent)", color: "#fff" }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--accent)" }}>{error}</p>
      )}

      <div className="mt-4">
        {loading ? (
          <div className="space-y-2">
            <div className="h-12 rounded-xl shimmer" />
            <div className="h-12 rounded-xl shimmer" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-xs py-6 text-center" style={{ color: "var(--faint)" }}>
            Nothing logged yet. Whatever you write here is what stops someone else emailing them tomorrow.
          </p>
        ) : (
          items.map((a, i) => {
            const Icon = ICONS[a.kind] ?? StickyNote;
            const color = KIND_COLOR[a.kind] ?? "var(--muted)";
            return (
              <div key={a.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className="grid place-items-center w-7 h-7 rounded-full shrink-0 border"
                    style={{ background: "var(--surface2)", borderColor: "var(--border)", color }}
                  >
                    <Icon size={13} />
                  </span>
                  {/* The rail joins entries, so it stops at the last one. */}
                  {i < items.length - 1 && <span className="w-px flex-1 my-1" style={{ background: "var(--border)" }} />}
                </div>
                <div className="pb-4 min-w-0 flex-1">
                  <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text)" }}>
                    {line(a)}
                  </p>
                  <div className="mt-0.5 text-[11px]" style={{ color: "var(--faint)" }}>
                    {a.kind === "status_change" ? ago(a.created_at) : `${a.actor_name ?? "Unknown"} · ${ago(a.created_at)}`}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
