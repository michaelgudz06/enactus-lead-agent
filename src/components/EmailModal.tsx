"use client";

import { useCallback, useEffect, useState } from "react";
import { X, RefreshCw, Copy, Check, Mail, Send } from "lucide-react";
import { Lead } from "@/lib/types";
import { EmailTemplate, Sender, fillTemplate } from "@/lib/template";

type DraftEvent =
  | { type: "meta"; to: string | null; draftId: string | null }
  | { type: "subject"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; draftId: string | null; subject: string; body: string; warnings?: string[] }
  | { type: "error"; message: string };

export default function EmailModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  // The modal drafts as soon as it opens, so this is true from the first frame
  // -- starting false meant a flash of the non-streaming layout, and made run()'s
  // setStreaming(true) a real state change during the mount effect.
  const [streaming, setStreaming] = useState(true);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [to, setTo] = useState<string | null>(lead.contact_email);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // The route lints the finished body against the facts it was given. An
  // unverified claim has to be visible at the moment of sending, not logged.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [gmail, setGmail] = useState<{ ok: boolean; msg: string } | null>(null);

  const [senders, setSenders] = useState<Sender[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [senderId, setSenderId] = useState("");
  const [templateId, setTemplateId] = useState("");

  // Sender and template are arguments rather than read from state, so a picker
  // handler can act on the value it just set instead of the previous render's.
  const run = useCallback(async (force: boolean, tpl: EmailTemplate | null, snd: Sender | null) => {
    setError("");
    setWarnings((w) => (w.length ? [] : w));
    setStreaming(true);
    // Same fillTemplate the settings preview uses, and the same rule about only
    // passing values that exist: a lead with no industry has to keep showing
    // {{industry}} rather than send a hole where the preview showed a token.
    const vals: Record<string, string> = {};
    const known: [string, string | null | undefined][] = [
      ["company", lead.company],
      ["contact_name", lead.contact_name ?? lead.company],
      ["why_fit", lead.why_fit],
      ["industry", lead.industry],
      ["location", lead.location],
      ["sender_name", snd?.name],
    ];
    for (const [k, v] of known) if (v) vals[k] = v;
    // A template needs no model at all: substitute and show it now, then post
    // the same text so the row is saved.
    const pre = tpl ? { subject: fillTemplate(tpl.subject ?? "", vals), body: fillTemplate(tpl.body ?? "", vals) } : null;
    if (pre) {
      setSubject(pre.subject);
      setBody(pre.body);
      setLoading(false);
    }
    try {
      const res = await fetch("/api/email/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: lead.id,
          force,
          senderId: snd?.id ?? null,
          templateId: tpl?.id ?? null,
          senderName: snd?.name,
          senderTitle: snd?.title ?? undefined,
          ...(pre ?? {}),
        }),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: DraftEvent;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === "meta") {
            setLoading(false);
            setDraftId(ev.draftId);
            if (ev.to) setTo(ev.to);
          } else if (ev.type === "subject") {
            setSubject(ev.text);
          } else if (ev.type === "delta") {
            acc += ev.text;
            setBody(acc);
          } else if (ev.type === "done") {
            setDraftId(ev.draftId);
            setSubject(ev.subject);
            setBody(ev.body);
            setWarnings(ev.warnings ?? []);
          } else if (ev.type === "error") {
            throw new Error(ev.message);
          }
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setStreaming(false);
    }
  }, [lead]);

  useEffect(() => {
    // run() resets error/warnings/streaming up front for the retry path. On
    // mount each of those writes the value the state already holds, so nothing
    // cascades -- but the rule is syntactic and cannot check that.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    run(false, null, null);
  }, [run]);

  // Both endpoints belong to a change that may not have landed. A 404 just
  // means no pickers, never a broken modal.
  useEffect(() => {
    const load = async <T,>(url: string, key: string, set: (v: T[]) => void) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data?.[key])) set(data[key]);
      } catch {
        // endpoint not there yet
      }
    };
    load<Sender>("/api/senders", "senders", setSenders);
    load<EmailTemplate>("/api/templates", "templates", setTemplates);
  }, []);

  const sender = senders.find((s) => s.id === senderId) ?? null;
  const template = templates.find((t) => t.id === templateId) ?? null;

  function pickTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id) ?? null;
    if (t) run(false, t, sender);
  }

  function pickSender(id: string) {
    setSenderId(id);
    // Re-rendering a template with the new sign-off is free; a generated email
    // is not, so that one waits for Regenerate.
    const s = senders.find((x) => x.id === id) ?? null;
    if (template) run(false, template, s);
  }

  function copy() {
    navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function openInGmail() {
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to || "")}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank");
  }

  async function createGmailDraft() {
    if (creating) return;
    setCreating(true);
    setGmail(null);
    try {
      const res = await fetch("/api/gmail/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // rowId targets this exact draft; leadId is only the fallback.
        body: JSON.stringify({ to, subject, body, leadId: lead.id, rowId: draftId }),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      // A popup keeps this modal, and the draft in it, alive.
      if (res.status === 428) {
        window.open("/api/gmail/auth", "gmail-connect", "width=520,height=650");
        setGmail({ ok: false, msg: "Connect your Google account in the popup, then click again." });
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setGmail({ ok: true, msg: "Draft created in your Gmail. Open Gmail to review and send." });
    } catch (e) {
      setGmail({ ok: false, msg: (e as Error).message });
    } finally {
      setCreating(false);
    }
  }

  const selectStyle = { background: "var(--surface2)", borderColor: "var(--border)", color: "var(--text)" };

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }} onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-2xl border animate-in max-h-[90vh] overflow-y-auto"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b sticky top-0" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div>
            <div className="font-semibold text-sm">Draft outreach · {lead.company}</div>
            <div className="text-xs" style={{ color: "var(--faint)" }}>Human, concise, one clear ask. No em dashes.</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--surface3)]" style={{ color: "var(--muted)" }}>
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {(senders.length > 0 || templates.length > 0) && (
            <div className="flex gap-2 flex-wrap">
              {senders.length > 0 && (
                <div className="flex-1 min-w-[9rem]">
                  <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>From</label>
                  <select
                    value={senderId}
                    onChange={(e) => pickSender(e.target.value)}
                    disabled={streaming}
                    className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none border disabled:opacity-60"
                    style={selectStyle}
                  >
                    <option value="">Me (default)</option>
                    {senders.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.title ? `, ${s.title}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {templates.length > 0 && (
                <div className="flex-1 min-w-[9rem]">
                  <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>Template</label>
                  <select
                    value={templateId}
                    onChange={(e) => pickTemplate(e.target.value)}
                    disabled={streaming}
                    className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none border disabled:opacity-60"
                    style={selectStyle}
                  >
                    <option value="">Write with AI</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>To</label>
            <input
              value={to || ""}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@company.com"
              className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none border"
              style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
            />
          </div>

          {loading ? (
            <div className="space-y-2 py-4">
              <div className="h-4 rounded shimmer w-1/2" />
              <div className="h-24 rounded shimmer" />
            </div>
          ) : error ? (
            <p className="text-sm" style={{ color: "var(--accent)" }}>{error}</p>
          ) : (
            <>
              <div>
                <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>Subject</label>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none border font-medium"
                  style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
                />
              </div>
              <div>
                <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                  Body {streaming && <span style={{ color: "var(--faint)" }}>· writing…</span>}
                </label>
                {warnings.length > 0 && (
                  <ul className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700">
                    {warnings.map((m) => <li key={m}>Check before sending: {m}</li>)}
                  </ul>
                )}
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={14}
                  className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none border leading-relaxed resize-y"
                  style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
                />
              </div>
            </>
          )}

          {gmail && (
            <p className="text-xs" style={{ color: gmail.ok ? "var(--green)" : "var(--accent)" }}>{gmail.msg}</p>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3.5 border-t flex-wrap" style={{ borderColor: "var(--border)" }}>
          <button
            onClick={() => run(true, template, sender)}
            disabled={streaming}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50"
            style={{ background: "var(--surface3)", color: "var(--text)" }}
          >
            <RefreshCw size={13} className={streaming ? "animate-spin" : ""} /> Regenerate
          </button>
          <button onClick={copy} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium" style={{ background: "var(--surface3)", color: "var(--text)" }}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
          </button>
          <button onClick={openInGmail} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium" style={{ background: "var(--surface3)", color: "var(--text)" }}>
            <Mail size={13} /> Open in Gmail
          </button>
          <button
            onClick={createGmailDraft}
            disabled={creating || streaming}
            className="ml-auto flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-black disabled:opacity-50"
            style={{ background: "var(--gold)" }}
          >
            <Send size={13} /> {creating ? "Creating…" : "Create Gmail draft"}
          </button>
        </div>
      </div>
    </div>
  );
}
