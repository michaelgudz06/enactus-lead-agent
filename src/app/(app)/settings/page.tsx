"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Mail, Plus, RefreshCw, Star, Trash2, UserRound } from "lucide-react";
import { Lead } from "@/lib/types";
import { EmailTemplate, PLACEHOLDERS, Sender, fillTemplate } from "@/lib/template";

const FIELD = "w-full rounded-lg border px-2.5 py-1.5 text-sm outline-none";
const fieldStyle = { background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" };

type ApiResult = { error?: string; warning?: string; senders?: Sender[]; templates?: EmailTemplate[]; leads?: Lead[] };

// Every request goes through here so a failure can never read as a success. An
// expired session answers with the bare text "Unauthorized", which does not
// parse as JSON: swallowed, that showed an empty page indistinguishable from a
// database with nothing saved in it yet.
async function api(url: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => null);
    if (res.ok && data) return data;
    return { error: data?.error ?? `Request failed (${res.status}).` };
  } catch {
    return { error: "Could not reach the server." };
  }
}

// Destructive actions arm in place instead of raising confirm(): a browser
// dialog steals focus from a half-written template and cannot be styled to look
// like it belongs to this app.
function InlineDelete({ title, onConfirm }: { title: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        onClick={() => setArmed(true)}
        className="p-1.5 rounded-lg hover:bg-[var(--surface3)]"
        style={{ color: "var(--faint)" }}
        title={title}
      >
        <Trash2 size={13} />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span style={{ color: "var(--muted)" }}>Delete?</span>
      <button onClick={onConfirm} className="px-2 py-1 rounded-lg font-medium" style={{ background: "var(--accent)", color: "#fff" }}>
        Yes
      </button>
      <button onClick={() => setArmed(false)} className="px-2 py-1 rounded-lg font-medium" style={{ background: "var(--surface3)", color: "var(--muted)" }}>
        Cancel
      </button>
    </div>
  );
}

function SenderCard({ sender, onChanged }: { sender: Sender; onChanged: () => void }) {
  const [draft, setDraft] = useState(sender);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const keys = ["name", "email", "title", "signature"] as const;
  const dirty = keys.some((k) => (draft[k] ?? "") !== (sender[k] ?? ""));

  async function save() {
    setBusy(true);
    setError("");
    const { error: failed } = await api(`/api/senders/${sender.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: draft.name, email: draft.email, title: draft.title, signature: draft.signature }),
    });
    setBusy(false);
    if (failed) {
      setError(failed);
      return;
    }
    onChanged();
  }

  async function remove() {
    const { error: failed } = await api(`/api/senders/${sender.id}`, { method: "DELETE" });
    if (failed) {
      setError(failed);
      return;
    }
    onChanged();
  }

  return (
    <div className="rounded-xl border p-3 card-hover animate-in" style={{ background: "var(--surface2)", borderColor: "var(--border)" }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Name"
            className={`${FIELD} font-semibold`}
            style={fieldStyle}
          />
          <input
            value={draft.title ?? ""}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Title (VP External, President…)"
            className={FIELD}
            style={fieldStyle}
          />
          <input
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            placeholder="name@enactussfu.ca"
            className={FIELD}
            style={fieldStyle}
          />
        </div>
        <InlineDelete title="Delete sender" onConfirm={remove} />
      </div>

      <div className="mt-2.5">
        <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--faint)" }}>
          Signature
        </div>
        <textarea
          value={draft.signature ?? ""}
          onChange={(e) => setDraft({ ...draft, signature: e.target.value })}
          rows={4}
          placeholder={"Your name\nYour role, Enactus SFU\nPhone or booking link"}
          className={`${FIELD} font-mono text-xs leading-relaxed resize-y`}
          style={fieldStyle}
        />
      </div>

      {error && (
        <p className="mt-1.5 text-[11px]" style={{ color: "var(--accent)" }}>
          {error}
        </p>
      )}

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={save}
          disabled={!dirty || busy}
          className="px-2.5 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40"
          style={{ background: dirty ? "var(--accent)" : "var(--surface3)", color: dirty ? "#fff" : "var(--muted)" }}
        >
          {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
      </div>
    </div>
  );
}

interface TemplateDraft {
  id: string | null;
  name: string;
  subject: string;
  body: string;
  sender_id: string;
  is_default: boolean;
}
const BLANK: TemplateDraft = { id: null, name: "", subject: "", body: "", sender_id: "", is_default: false };

// Nothing on this page saves until a button is pressed, and the template body is
// a 16-row textarea someone writes over several sittings. Closing the tab threw
// all of it away -- which is how the board ended up with 0 senders and 0
// templates while the volunteer believed they had set both up.
//
// localStorage rather than a drafts table: this is unsent, unshared,
// per-browser scratch text, and a row in Neon for it would need its own route,
// its own cleanup and its own answer to "whose draft is this".
const DRAFT_KEY = "enactus.settings.draft.v1";

interface Draft {
  newSender: { name: string; email: string; title: string; signature: string };
  form: TemplateDraft;
}

const hasText = (o: Record<string, unknown>) =>
  Object.values(o).some((v) => typeof v === "string" && v.trim() !== "");

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    // Shape-checked rather than trusted: this string outlives deploys, so a
    // draft written by an older version must not crash the page it reopens in.
    if (!d || typeof d !== "object" || !d.newSender || !d.form) return null;
    return {
      newSender: { ...{ name: "", email: "", title: "", signature: "" }, ...d.newSender },
      form: { ...BLANK, ...d.form },
    };
  } catch {
    return null;
  }
}

export default function SettingsPage() {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [previewLead, setPreviewLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");

  const [newSender, setNewSender] = useState({ name: "", email: "", title: "", signature: "" });
  const [form, setForm] = useState<TemplateDraft>(BLANK);
  const [formError, setFormError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  // Unsaved work exists whenever either composer has text in it. Both the
  // autosave below and the close guard key off this, so they can never disagree
  // about whether there is something to lose.
  const dirty = hasText(newSender) || hasText({ name: form.name, subject: form.subject, body: form.body });

  // Deliberately does not raise the loading flag itself: doing so would be a
  // synchronous setState inside the mount effect below. The spinner starts on
  // and is switched on again by the refresh button, which is an event handler.
  const load = useCallback(async () => {
    const [s, t, l] = await Promise.all([
      api("/api/senders"),
      api("/api/templates"),
      api("/api/leads?mode=sponsor"),
    ]);
    setSenders(s.senders ?? []);
    setTemplates(t.templates ?? []);
    // The preview borrows a lead that is actually in the pipeline rather than a
    // made-up "Acme Corp", so what it renders is what would really be sent.
    setPreviewLead((l.leads ?? [])[0] ?? null);
    setNotice(s.error ?? t.error ?? l.error ?? s.warning ?? t.warning ?? "");
    setLoading(false);
  }, []);

  useEffect(() => {
    // The rule counts any call that can reach a setState, but every one of
    // load()'s is on the far side of an await, so none run during this render.
    // Same mount-fetch shape the board page uses.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Restore before the first paint the user can type into, but never during
  // render: localStorage does not exist on the server, so reading it while
  // rendering would make the two markups disagree.
  useEffect(() => {
    const d = readDraft();
    if (!d) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot restore on mount; no dependency can re-run it
    setNewSender(d.newSender);
    setForm(d.form);
    setRestored(true);
  }, []);

  // Autosave. Cheap enough to run on every keystroke -- the whole payload is a
  // few kilobytes of text -- so there is no debounce to get wrong.
  useEffect(() => {
    try {
      if (dirty) localStorage.setItem(DRAFT_KEY, JSON.stringify({ newSender, form }));
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Private mode, or the quota is full. The close guard below still fires,
      // which is the part that prevents the loss.
    }
  }, [dirty, newSender, form]);

  // The browser's own "Leave site?" dialog. Autosave already survives a closed
  // tab, but this catches the case it cannot: a different browser, a cleared
  // profile, or a volunteer who never comes back to this machine.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function clearDraft() {
    setRestored(false);
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* nothing to clear */
    }
  }

  async function addSender() {
    const { error } = await api("/api/senders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newSender),
    });
    if (error) {
      setNotice(error);
      return;
    }
    setNewSender({ name: "", email: "", title: "", signature: "" });
    setNotice("");
    setRestored(false);
    load();
  }

  async function saveTemplate() {
    if (!form.name.trim()) {
      setFormError("Give the template a name so you can pick it later.");
      return;
    }
    const { error } = await api(form.id ? `/api/templates/${form.id}` : "/api/templates", {
      method: form.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim(),
        subject: form.subject,
        body: form.body,
        sender_id: form.sender_id || null,
        is_default: form.is_default,
      }),
    });
    if (error) {
      setFormError(error);
      return;
    }
    setFormError("");
    setForm(BLANK);
    setRestored(false);
    load();
  }

  async function makeDefault(id: string) {
    const { error } = await api(`/api/templates/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_default: true }),
    });
    if (error) setNotice(error);
    load();
  }

  async function removeTemplate(id: string) {
    const { error } = await api(`/api/templates/${id}`, { method: "DELETE" });
    if (error) setNotice(error);
    else if (form.id === id) setForm(BLANK);
    load();
  }

  async function copyPlaceholder(p: string) {
    try {
      await navigator.clipboard.writeText(`{{${p}}}`);
      setCopied(p);
      setTimeout(() => setCopied((c) => (c === p ? null : c)), 1200);
    } catch {
      // Clipboard is blocked outside a secure context; the token is on screen
      // to be selected by hand, so there is nothing useful to report here.
    }
  }

  const selectedSender = senders.find((s) => s.id === form.sender_id) ?? null;

  // Only values that genuinely exist are passed: fillTemplate leaves an unknown
  // placeholder standing, which is how a missing industry or contact name stays
  // visible in the preview instead of quietly becoming a blank in the sent mail.
  const vars: Record<string, string> = {};
  if (previewLead) {
    const pairs: [string, string | null][] = [
      ["company", previewLead.company],
      ["contact_name", previewLead.contact_name],
      ["why_fit", previewLead.why_fit],
      ["industry", previewLead.industry],
      ["location", previewLead.location],
    ];
    for (const [k, v] of pairs) if (v) vars[k] = v;
  }
  if (selectedSender?.name) vars.sender_name = selectedSender.name;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
        <div>
          <h1 className="text-sm font-semibold">Templates</h1>
          <p className="text-xs" style={{ color: "var(--faint)" }}>
            Who the outreach comes from, and what it says.
          </p>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            load();
          }}
          className="p-1.5 rounded-lg hover:bg-[var(--surface3)]"
          style={{ color: "var(--muted)" }}
          title="Refresh"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {notice && (
        <div className="mx-5 mt-3 text-xs rounded-lg px-3 py-2" style={{ background: "rgba(230,57,70,.1)", color: "var(--text)" }}>
          {notice}
        </div>
      )}

      {/* Restoring silently would be worse than losing it: the volunteer needs
          to know the text on screen is theirs from last time and still unsaved. */}
      {restored && (
        <div className="mx-5 mt-3 flex items-center gap-3 text-xs rounded-lg px-3 py-2" style={{ background: "rgba(245,200,66,.12)", color: "var(--text)" }}>
          <span>
            Picked up where you left off. This is still a <strong>draft</strong> — press Add sender or Create
            template to actually save it.
          </span>
          <button onClick={clearDraft} className="ml-auto text-[11px] shrink-0" style={{ color: "var(--faint)" }}>
            Dismiss
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-7">
        <section>
          <div className="flex items-center gap-2 mb-3">
            <UserRound size={15} style={{ color: "var(--gold)" }} />
            <h2 className="text-sm font-semibold">Senders</h2>
            <span className="text-xs" style={{ color: "var(--faint)" }}>
              {senders.length} {senders.length === 1 ? "identity" : "identities"}
            </span>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {senders.map((s) => (
              <SenderCard key={s.id} sender={s} onChanged={load} />
            ))}

            <div className="rounded-xl border border-dashed p-3" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <div className="text-xs font-semibold mb-2">Add sender</div>
              <div className="space-y-1.5">
                <input
                  value={newSender.name}
                  onChange={(e) => setNewSender({ ...newSender, name: e.target.value })}
                  placeholder="Name"
                  className={FIELD}
                  style={fieldStyle}
                />
                <input
                  value={newSender.title}
                  onChange={(e) => setNewSender({ ...newSender, title: e.target.value })}
                  placeholder="Title"
                  className={FIELD}
                  style={fieldStyle}
                />
                <input
                  value={newSender.email}
                  onChange={(e) => setNewSender({ ...newSender, email: e.target.value })}
                  placeholder="name@enactussfu.ca"
                  className={FIELD}
                  style={fieldStyle}
                />
                <textarea
                  value={newSender.signature}
                  onChange={(e) => setNewSender({ ...newSender, signature: e.target.value })}
                  rows={3}
                  placeholder="Signature"
                  className={`${FIELD} font-mono text-xs leading-relaxed resize-y`}
                  style={fieldStyle}
                />
              </div>
              <button
                onClick={addSender}
                className="mt-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium"
                style={{ background: "var(--accent)", color: "#fff" }}
              >
                <Plus size={13} /> Add sender
              </button>
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-3">
            <Mail size={15} style={{ color: "var(--gold)" }} />
            <h2 className="text-sm font-semibold">Templates</h2>
            <span className="text-xs" style={{ color: "var(--faint)" }}>
              {templates.length} saved
            </span>
          </div>

          {templates.length > 0 && (
            <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3 mb-4">
              {templates.map((t) => (
                <div
                  key={t.id}
                  className="rounded-xl border p-3 card-hover animate-in"
                  style={{ background: "var(--surface2)", borderColor: form.id === t.id ? "var(--gold)" : "var(--border)" }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm leading-tight truncate">{t.name}</div>
                      <div className="text-[11px] truncate" style={{ color: "var(--muted)" }}>
                        {t.subject || "No subject"}
                      </div>
                    </div>
                    <button
                      onClick={() => makeDefault(t.id)}
                      className="shrink-0 p-1 rounded-lg hover:bg-[var(--surface3)]"
                      style={{ color: t.is_default ? "var(--gold)" : "var(--faint)" }}
                      title={t.is_default ? "This is the default template" : "Make default"}
                    >
                      <Star size={14} fill={t.is_default ? "var(--gold)" : "none"} />
                    </button>
                  </div>

                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                    {t.is_default && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--surface3)", color: "var(--gold)" }}>
                        default
                      </span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--surface3)", color: "var(--blue)" }}>
                      {senders.find((s) => s.id === t.sender_id)?.name ?? "no sender"}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() =>
                        setForm({
                          id: t.id,
                          name: t.name,
                          subject: t.subject ?? "",
                          body: t.body ?? "",
                          sender_id: t.sender_id ?? "",
                          is_default: t.is_default,
                        })
                      }
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium"
                      style={{ background: "var(--surface3)", color: "var(--muted)" }}
                    >
                      Edit
                    </button>
                    <div className="ml-auto">
                      <InlineDelete title="Delete template" onConfirm={() => removeTemplate(t.id)} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border p-3.5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <div className="flex items-center justify-between mb-2.5">
                <div className="text-xs font-semibold">{form.id ? "Edit template" : "New template"}</div>
                {form.id && (
                  <button onClick={() => setForm(BLANK)} className="text-[11px]" style={{ color: "var(--faint)" }}>
                    Cancel edit
                  </button>
                )}
              </div>

              <div className="space-y-2">
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Name — e.g. Cold intro, in-kind ask"
                  className={FIELD}
                  style={fieldStyle}
                />
                <input
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  placeholder="Subject — Enactus SFU × {{company}}"
                  className={FIELD}
                  style={fieldStyle}
                />
                <textarea
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  rows={16}
                  placeholder={"Hi {{contact_name}},\n\nPaste your template here…"}
                  className={`${FIELD} font-mono text-xs leading-relaxed resize-y`}
                  style={fieldStyle}
                />

                <div className="flex items-center gap-2">
                  <select
                    value={form.sender_id}
                    onChange={(e) => setForm({ ...form, sender_id: e.target.value })}
                    className={FIELD}
                    style={fieldStyle}
                  >
                    <option value="">Send as… (no sender)</option>
                    {senders.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.title ? ` — ${s.title}` : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => setForm({ ...form, is_default: !form.is_default })}
                    className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border"
                    style={{
                      background: form.is_default ? "var(--surface3)" : "transparent",
                      borderColor: form.is_default ? "var(--gold)" : "var(--border)",
                      color: form.is_default ? "var(--gold)" : "var(--muted)",
                    }}
                    title="Use this template unless another is picked"
                  >
                    <Star size={13} fill={form.is_default ? "var(--gold)" : "none"} /> Default
                  </button>
                </div>
              </div>

              <div className="mt-3">
                <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: "var(--faint)" }}>
                  Placeholders — click to copy
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PLACEHOLDERS.map((p) => (
                    <button
                      key={p}
                      onClick={() => copyPlaceholder(p)}
                      className="flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded"
                      style={{ background: "var(--surface3)", color: copied === p ? "var(--green)" : "var(--blue)" }}
                    >
                      {copied === p ? <Check size={11} /> : <Copy size={11} />}
                      {`{{${p}}}`}
                    </button>
                  ))}
                </div>
              </div>

              {formError && (
                <p className="mt-2 text-[11px]" style={{ color: "var(--accent)" }}>
                  {formError}
                </p>
              )}

              <button
                onClick={saveTemplate}
                className="mt-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium"
                style={{ background: "var(--accent)", color: "#fff" }}
              >
                <Plus size={13} /> {form.id ? "Save template" : "Create template"}
              </button>
            </div>

            <div className="rounded-xl border p-3.5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <div className="flex items-center justify-between mb-2.5">
                <div className="text-xs font-semibold">Live preview</div>
                <span className="text-[11px] truncate" style={{ color: "var(--faint)" }}>
                  {previewLead ? previewLead.company : "no lead to preview against"}
                </span>
              </div>

              {!previewLead && (
                <p className="text-[11px] mb-2.5" style={{ color: "var(--muted)" }}>
                  Find sponsors on the Agent tab first — the preview fills in against a real lead from your board, not a sample.
                </p>
              )}

              <div className="rounded-lg p-3" style={{ background: "var(--bg)" }}>
                <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--faint)" }}>
                  Subject
                </div>
                <div className="text-sm font-medium mt-0.5 break-words">
                  {fillTemplate(form.subject, vars) || <span style={{ color: "var(--faint)" }}>—</span>}
                </div>

                <div className="text-[10px] uppercase tracking-wider mt-3" style={{ color: "var(--faint)" }}>
                  Body
                </div>
                <pre className="text-xs leading-relaxed mt-0.5 whitespace-pre-wrap break-words font-mono" style={{ color: "var(--text)" }}>
                  {fillTemplate(form.body, vars) || <span style={{ color: "var(--faint)" }}>Paste a template to see it filled in.</span>}
                </pre>

                {selectedSender?.signature && (
                  <>
                    <div className="text-[10px] uppercase tracking-wider mt-3" style={{ color: "var(--faint)" }}>
                      Signature — {selectedSender.email}
                    </div>
                    <pre className="text-xs leading-relaxed mt-0.5 whitespace-pre-wrap break-words font-mono" style={{ color: "var(--muted)" }}>
                      {selectedSender.signature}
                    </pre>
                  </>
                )}
              </div>

              <p className="mt-2 text-[11px]" style={{ color: "var(--faint)" }}>
                A placeholder still showing as {"{{…}}"} means that lead has no value for it — it will not be blanked out for you.
              </p>
            </div>
          </div>
        </section>

        {/* The escape hatch, deliberately the last thing on the page and
            deliberately spelled out. This board lives in one Neon project on
            one student's personal account, and the two Supabase projects behind
            earlier versions of this app both vanished without warning. A CSV in
            a Drive folder is the copy that survives a handover. */}
        <section className="rounded-2xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <h2 className="text-sm font-semibold">Data</h2>
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            Every lead, with its stage, amount, owner and contact, as a spreadsheet. Take one before you hand the
            club over — this database sits on a personal account and nothing else has a copy.
          </p>
          <a
            href="/api/export"
            download
            className="mt-3 inline-flex items-center gap-2 text-xs font-semibold rounded-lg px-3 py-2"
            style={{ background: "var(--gold)", color: "#1a1a1a" }}
          >
            Download CSV backup
          </a>
          <p className="mt-3 text-[11px]" style={{ color: "var(--faint)" }}>
            To take one automatically, set a <code>BACKUP_TOKEN</code> environment variable and run this on a
            schedule:
          </p>
          <pre className="mt-1 text-[11px] leading-relaxed whitespace-pre-wrap break-all font-mono" style={{ color: "var(--muted)" }}>
            {`curl -H "Authorization: Bearer $BACKUP_TOKEN" \\\n  https://enactus-agent-mocha.vercel.app/api/export \\\n  -o ~/Backups/enactus-$(date +%F).csv`}
          </pre>
        </section>
      </div>
    </div>
  );
}
