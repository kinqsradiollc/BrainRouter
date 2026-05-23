"use client";

// Memory-augmented chat for the web app, styled in the BrainRouter design
// language (Midnight Ledger / Obsidian Surfaces, per BRAINROUTER_DESIGN.MD).
//
// Behavior:
//   - POSTs to the MCP server's /v1/chat/completions endpoint, which runs
//     memory_recall + working_context briefing before forwarding upstream
//     and captures the turn after.
//   - SSE streaming with explicit AbortController so a new submit cancels
//     the previous in-flight request and unmounting tears the connection
//     down. Paired with the server's [DONE] sentinel + idle watchdog this
//     fixes the "requests keep coming nonstop" symptom.
//   - Visual: dark canvas, transparent cards, pill input, pill primary
//     action, Inter body, golden accent reserved for emphasis.

import { useCallback, useEffect, useRef, useState } from "react";
import { BASE_URL } from "../../lib/client";
import { getApiKey, getJwt } from "../../lib/client-auth";
import { Markdown } from "../../components/Markdown";
import { PageHeader } from "../../components/PageHeader";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  id: string;
  /** True while a streaming assistant response is still being filled. */
  pending?: boolean;
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const SESSION_KEY_STORAGE = "brainrouter_chat_session_key";

function loadOrCreateSessionKey(): string {
  if (typeof window === "undefined") return "web:anonymous";
  const existing = localStorage.getItem(SESSION_KEY_STORAGE);
  if (existing) return existing;
  const fresh = `web:${crypto.randomUUID()}`;
  localStorage.setItem(SESSION_KEY_STORAGE, fresh);
  return fresh;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Persistence mode for captured messages.
  //   "sensory" — default. Store one sensory row per message; zero upstream
  //               LLM calls per turn. The cognitive extraction cascade
  //               (contradictions + graph + persona, each of which can fire
  //               their own LLM call) does NOT run.
  //   "full"    — every turn triggers the full cascade. Dozens of background
  //               upstream calls per turn — only use when you know what you're
  //               doing. The "Distill memories now" button is usually a better
  //               way to learn new memories without blowing up the queue.
  //   "off"     — stateless chat.
  const [captureMode, setCaptureMode] = useState<"full" | "sensory" | "off">("sensory");
  const [distilling, setDistilling] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const sessionKeyRef = useRef<string>("web:anonymous");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // AbortController lives on a ref so a fresh submit can cancel the previous
  // in-flight stream and so unmount cleanly tears the connection down. Without
  // this, a hung upstream connection would keep the browser fetching forever.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    sessionKeyRef.current = loadOrCreateSessionKey();
    return () => {
      try { abortRef.current?.abort(); } catch { /* noop */ }
    };
  }, []);

  // Explicit, user-initiated distillation. POSTs once, server-side per-user
  // lock prevents duplicate work even if the user clicks twice or has multiple
  // tabs open. This is the safe way to upgrade sensory rows to cognitive
  // memories without firing the cascade on every chat turn.
  const distillNow = useCallback(async () => {
    const auth = getJwt() || getApiKey();
    if (!auth || distilling) return;
    setDistilling(true);
    try {
      const res = await fetch(`${BASE_URL}/v1/distill`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` },
        body: JSON.stringify({ sessionKey: sessionKeyRef.current }),
      });
      if (!res.ok) {
        setError(`Distill failed: ${res.status}`);
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setDistilling(false);
    }
  }, [distilling]);

  // Debounced auto-scroll: smooth scrollTo on every streaming chunk fights the
  // browser's own scroll animation. We schedule one rAF per render instead.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages]);

  const stop = useCallback(() => {
    try { abortRef.current?.abort(); } catch { /* noop */ }
    abortRef.current = null;
    setBusy(false);
  }, []);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setError(null);

    // Cancel any prior in-flight request before starting a new one.
    try { abortRef.current?.abort(); } catch { /* noop */ }
    const controller = new AbortController();
    abortRef.current = controller;

    const userMsg: ChatMessage = { role: "user", content: trimmed, id: newId() };
    const assistantMsg: ChatMessage = { role: "assistant", content: "", id: newId(), pending: true };

    const outbound: ChatMessage[] = [...messages, userMsg];
    setMessages([...outbound, assistantMsg]);
    setInput("");
    setBusy(true);

    const auth = getJwt() || getApiKey();
    if (!auth) {
      setError("Sign in or set an API key to use chat.");
      setBusy(false);
      setMessages((m) => m.filter((x) => x.id !== assistantMsg.id));
      return;
    }

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth}`,
        },
        body: JSON.stringify({
          // Model is server-configured; clients don't override it from the chat UI.
          stream: true,
          messages: outbound.map((m) => ({ role: m.role, content: m.content })),
          brainrouter: {
            sessionKey: sessionKeyRef.current,
            capture_mode: captureMode,
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text();
        throw new Error(text || `Upstream returned ${res.status}`);
      }

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let streamDone = false;

      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") {
            streamDone = true;
            // Free the upstream socket promptly. Without this the connection
            // can linger and the browser counts it as an in-flight request.
            try { await reader.cancel(); } catch { /* noop */ }
            break;
          }
          try {
            const obj = JSON.parse(data);
            const delta = obj?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              accumulated += delta;
              setMessages((m) =>
                m.map((x) => (x.id === assistantMsg.id ? { ...x, content: accumulated } : x)),
              );
            }
          } catch {
            // Ignore non-JSON SSE keepalive frames.
          }
        }
      }
      setMessages((m) =>
        m.map((x) => (x.id === assistantMsg.id ? { ...x, pending: false } : x)),
      );
    } catch (err: any) {
      if (err?.name === "AbortError") {
        // Quiet — this is our own stop() or a new submit superseding the old one.
        setMessages((m) => m.map((x) => (x.id === assistantMsg.id ? { ...x, pending: false, content: x.content || "_(stopped)_" } : x)));
      } else {
        setError(err?.message || String(err));
        setMessages((m) => m.filter((x) => x.id !== assistantMsg.id));
      }
    } finally {
      try { await reader?.cancel(); } catch { /* noop */ }
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }, [busy, input, messages, captureMode]);

  const resetSession = useCallback(() => {
    if (typeof window === "undefined") return;
    try { abortRef.current?.abort(); } catch { /* noop */ }
    localStorage.removeItem(SESSION_KEY_STORAGE);
    sessionKeyRef.current = loadOrCreateSessionKey();
    setMessages([]);
    setError(null);
  }, []);

  // ---- Styles (BrainRouter design tokens; no Tailwind utility colors here) ----

  const pageStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    height: "calc(100vh - 80px)",
    color: "var(--color-pure-white)",
    fontFamily: "var(--font-inter)",
  };
  const ghostBtnStyle: React.CSSProperties = {
    background: "transparent",
    color: "var(--color-pure-white)",
    border: "1px solid var(--border-med)",
    borderRadius: "9999px",
    padding: "6px 14px",
    fontSize: "12px",
    cursor: "pointer",
    fontFamily: "var(--font-inter)",
  };
  const transcriptStyle: React.CSSProperties = {
    flex: 1,
    overflowY: "auto",
    padding: "32px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  };
  const userBubbleStyle: React.CSSProperties = {
    alignSelf: "flex-end",
    maxWidth: "min(720px, 100%)",
    background: "var(--color-slate-gray)",
    color: "var(--color-pure-white)",
    border: "1px solid var(--border-dim)",
    borderRadius: "10px",
    padding: "16px 20px",
    fontSize: "14px",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  };
  const assistantBubbleStyle: React.CSSProperties = {
    alignSelf: "flex-start",
    maxWidth: "min(720px, 100%)",
    background: "var(--color-pewter-accent)",
    color: "var(--color-white-frost)",
    border: "1px solid var(--border-dim)",
    borderRadius: "10px",
    padding: "16px 20px",
    fontSize: "14px",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  };
  const bubbleLabelStyle: React.CSSProperties = {
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--color-stone-text)",
    marginBottom: "6px",
  };
  const composerStyle: React.CSSProperties = {
    borderTop: "1px solid var(--border-dim)",
    padding: "20px 32px",
    background: "var(--color-obsidian-surface)",
  };
  const composerInnerStyle: React.CSSProperties = {
    display: "flex",
    gap: "10px",
    alignItems: "flex-end",
    maxWidth: "920px",
    margin: "0 auto",
  };
  const textareaStyle: React.CSSProperties = {
    flex: 1,
    background: "transparent",
    color: "var(--color-pure-white)",
    border: "1px solid var(--border-med)",
    borderRadius: "20px",
    padding: "14px 20px",
    fontSize: "14px",
    lineHeight: 1.5,
    resize: "none",
    outline: "none",
    fontFamily: "var(--font-inter)",
    minHeight: "52px",
    maxHeight: "200px",
  };
  const primaryBtnStyle: React.CSSProperties = {
    background: "var(--color-pure-white)",
    color: "var(--color-midnight-ink)",
    border: "none",
    borderRadius: "9999px",
    padding: "0 28px",
    height: "44px",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "var(--font-inter)",
    opacity: busy || !input.trim() ? 0.4 : 1,
  };
  const stopBtnStyle: React.CSSProperties = {
    ...ghostBtnStyle,
    height: "44px",
    padding: "0 22px",
    borderColor: "var(--color-golden-accent)",
    color: "var(--color-golden-accent)",
  };
  const footnoteStyle: React.CSSProperties = {
    fontSize: "12px",
    color: "var(--color-stone-text)",
    textAlign: "center",
    marginTop: "10px",
  };
  const chipRowStyle: React.CSSProperties = {
    maxWidth: "920px",
    margin: "8px auto 0",
    display: "flex",
    gap: "8px",
    justifyContent: "center",
    flexWrap: "wrap",
  };
  const chipStyle: React.CSSProperties = {
    padding: "5px 12px",
    borderRadius: "9999px",
    border: "1px solid var(--border-med)",
    color: "var(--color-silver-text)",
    fontSize: "11px",
    textDecoration: "none",
    fontFamily: "var(--font-inter)",
  };
  const emptyStyle: React.CSSProperties = {
    margin: "auto",
    textAlign: "center",
    maxWidth: "440px",
    color: "var(--color-stone-text)",
    fontSize: "14px",
    lineHeight: 1.6,
  };
  const errorBoxStyle: React.CSSProperties = {
    alignSelf: "center",
    maxWidth: "720px",
    background: "rgba(204, 145, 102, 0.08)",
    border: "1px solid var(--color-golden-accent)",
    color: "var(--color-golden-accent)",
    borderRadius: "10px",
    padding: "12px 18px",
    fontSize: "13px",
  };

  return (
    <div style={pageStyle}>
      <div style={{ padding: "32px 32px 16px" }}>
        <PageHeader
          title="Memory-Augmented Chat"
          description="Talk to BrainRouter with your own memory. Every turn is recalled before responding and captured back after."
        >
          {/* Gear lives in PageHeader's right-aligned slot — no separate header row. */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setSettingsOpen((s) => !s)}
              title="Session settings"
              aria-expanded={settingsOpen}
              style={{
                ...ghostBtnStyle,
                padding: "6px 14px",
                borderColor: settingsOpen ? "var(--color-golden-accent)" : "var(--border-med)",
                color: settingsOpen ? "var(--color-golden-accent)" : "var(--color-silver-text)",
              }}
            >
              ⚙ Settings
            </button>
            {settingsOpen && (
              <>
                <div
                  onClick={() => setSettingsOpen(false)}
                  style={{ position: "fixed", inset: 0, zIndex: 10 }}
                />
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    right: 0,
                    zIndex: 20,
                    minWidth: "320px",
                    background: "var(--color-charcoal-canvas)",
                    border: "1px solid var(--border-med)",
                    borderRadius: "10px",
                    padding: "16px",
                    boxShadow: "0 12px 28px rgba(0,0,0,0.45)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "14px",
                    fontSize: "13px",
                    textAlign: "left",
                  }}
                >
                  <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <span style={{ color: "var(--color-stone-text)", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Persist mode</span>
                    <select
                      value={captureMode}
                      onChange={(e) => setCaptureMode(e.target.value as typeof captureMode)}
                      style={{
                        background: "transparent",
                        color: "var(--color-pure-white)",
                        border: "1px solid var(--border-med)",
                        borderRadius: "9999px",
                        padding: "8px 14px",
                        fontFamily: "var(--font-inter)",
                        fontSize: "13px",
                        cursor: "pointer",
                      }}
                    >
                      <option value="sensory">Sensory — store messages only (recommended)</option>
                      <option value="full">Full — extract cognitive memory each turn (heavy)</option>
                      <option value="off">Off — stateless chat</option>
                    </select>
                  </label>

                  <div style={{ height: "1px", background: "var(--border-dim)" }} />

                  <button
                    onClick={() => { setSettingsOpen(false); void distillNow(); }}
                    disabled={distilling}
                    style={{
                      ...ghostBtnStyle,
                      width: "100%",
                      padding: "10px 14px",
                      borderColor: distilling ? "var(--color-stone-text)" : "var(--color-golden-accent)",
                      color: distilling ? "var(--color-stone-text)" : "var(--color-golden-accent)",
                      cursor: distilling ? "wait" : "pointer",
                    }}
                  >
                    {distilling ? "Distilling…" : "Distill memories now"}
                  </button>
                  <button
                    onClick={() => { setSettingsOpen(false); resetSession(); }}
                    style={{ ...ghostBtnStyle, width: "100%", padding: "10px 14px" }}
                  >
                    Start a new session
                  </button>
                </div>
              </>
            )}
          </div>
        </PageHeader>
      </div>

      <div ref={scrollRef} style={transcriptStyle}>
        {messages.length === 0 && (
          <div style={emptyStyle}>
            <p style={{ margin: 0 }}>
              Start chatting. Your messages are recalled against your BrainRouter memory before
              each response and captured back after.
            </p>
            <p style={{ marginTop: "12px", fontSize: "12px", color: "var(--color-ash-text)" }}>
              Tip: ask about something you discussed in a previous session — the memory layer
              should surface it automatically.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} style={m.role === "user" ? userBubbleStyle : assistantBubbleStyle}>
            <div style={bubbleLabelStyle}>
              {m.role === "user" ? "You" : "BrainRouter"}{m.pending && " · thinking…"}
            </div>
            {m.role === "user" ? (
              <div>{m.content || (m.pending ? "…" : "")}</div>
            ) : (
              <div className="markdown-content markdown-content--chat">
                {m.content
                  ? <Markdown>{m.content}</Markdown>
                  : (m.pending ? "…" : "")}
              </div>
            )}
          </div>
        ))}
        {error && <div style={errorBoxStyle}>{error}</div>}
      </div>

      <div style={composerStyle}>
        <div style={composerInnerStyle}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask anything — your memory will be consulted first."
            rows={1}
            style={textareaStyle}
            disabled={busy}
          />
          {busy ? (
            <button onClick={stop} style={stopBtnStyle}>Stop</button>
          ) : (
            <button onClick={() => void send()} disabled={!input.trim()} style={primaryBtnStyle}>
              Send
            </button>
          )}
        </div>
        <p style={footnoteStyle}>
          Routes through <code style={{ color: "var(--color-silver-text)" }}>/v1/chat/completions</code> on your BrainRouter MCP server.
        </p>
        <div style={chipRowStyle}>
          <a href="/memories" style={chipStyle}>Memories</a>
          <a href="/scenes" style={chipStyle}>Focus scenes</a>
          <a href="/working-memory" style={chipStyle}>Working memory</a>
          <a href="/skills" style={chipStyle}>Skill routing</a>
        </div>
      </div>
    </div>
  );
}
