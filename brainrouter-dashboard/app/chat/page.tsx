"use client";

import Link from "next/link";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ModelPolicy } from "@kinqs/brainrouter-types";
import { AuthGuard } from "../../components/AuthGuard";
import { KnowledgeScopePicker, useKnowledgeScope } from "../../components/KnowledgeScopePicker";
import { LazyMarkdown } from "../../components/LazyMarkdown";
import { brainApi } from "../../lib/brainApi";
import { adminApi } from "../../lib/adminApi";
import { normalizeChatModelSelection, type ChatModelSelection } from "./chatModelSelection";
import { InlineLoading } from "../../components/LoadingSpinner";
import {
  loadChatSessions,
  sameChatScope,
  saveChatSessions,
  sessionTitle,
  upsertChatSession,
  type StoredChatMessage,
  type StoredChatSession,
} from "./chatSessions";

const categories = ["General", "Build", "Plan", "Recall", "Knowledge", "Review"] as const;
type ChatCategory = (typeof categories)[number];
const suggestions: Record<ChatCategory, ReadonlyArray<readonly [string, string]>> = {
  General: [
    ["Move a task forward", "Help me choose the next concrete step for the task in this workspace."],
    ["Understand this project", "Summarize the project, its current state, and the most important open work."],
    ["Check recent work", "Review what changed recently and tell me what still needs attention."],
  ],
  Build: [
    ["Plan an implementation", "Turn my requested change into a focused implementation and verification plan."],
    ["Trace a code path", "Find the code path behind the behavior I describe and explain how its parts connect."],
    ["Diagnose a failure", "Use the available project context to narrow down the cause of a failing behavior."],
  ],
  Plan: [
    ["Break down an outcome", "Turn my goal into ordered milestones, dependencies, and concrete next actions."],
    ["Prioritize the backlog", "Help me rank the current work by impact, urgency, and dependency risk."],
    ["Draft acceptance criteria", "Write measurable acceptance criteria for the task I am planning."],
  ],
  Recall: [
    ["Inspect recent recalls", "Show which saved context has been most useful in my latest agent sessions."],
    ["Find an earlier decision", "Recall the decision related to the topic I describe and include its evidence."],
    ["Prepare agent context", "Assemble the most relevant recalled context for the task I am starting next."],
  ],
  Knowledge: [
    ["Inspect saved knowledge", "Show what BrainRouter captured from my latest agent sessions and connected sources."],
    ["Find source evidence", "Find the source material that supports what BrainRouter knows about the topic I describe."],
    ["Find a knowledge gap", "Show where the selected project or workspace is missing useful durable context."],
  ],
  Review: [
    ["Review recent changes", "Assess the latest project changes for correctness, regressions, and missing tests."],
    ["Check delivery readiness", "Tell me what evidence is still missing before this work is ready to ship."],
    ["Verify an outcome", "Build a concise verification checklist for the outcome I describe."],
  ],
};

function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isCategory(value: string): value is ChatCategory {
  return (categories as readonly string[]).includes(value);
}

function ChatContent() {
  const scopeState = useKnowledgeScope();
  const [category, setCategory] = useState<ChatCategory>("General");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<StoredChatMessage[]>([]);
  const [sessions, setSessions] = useState<StoredChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [showScope, setShowScope] = useState(false);
  const [models, setModels] = useState<readonly ModelPolicy[]>([]);
  const [modelSelection, setModelSelection] = useState<ChatModelSelection>({ model: "", reasoningEffort: "" });
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState("");
  const sessionKey = useRef("");
  const threadEnd = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const currentScope = useRef(scopeState.scope);
  currentScope.current = scopeState.scope;

  useEffect(() => {
    setSessions(loadChatSessions(window.localStorage));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (scopeState.loading) return;
    let cancelled = false;
    setModelsLoading(true);
    setModelsError("");
    adminApi.modelCatalog(scopeState.scope.orgId || undefined).then((catalog) => {
      if (cancelled) return;
      setModels(catalog.models);
      setModelSelection((current) => normalizeChatModelSelection(catalog.models, current));
    }).catch((caught) => {
      if (cancelled) return;
      setModels([]);
      setModelsError(caught instanceof Error ? caught.message : "Could not load managed models");
    }).finally(() => {
      if (!cancelled) setModelsLoading(false);
    });
    return () => { cancelled = true; };
  }, [scopeState.loading, scopeState.scope.orgId]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  const scopedSessions = useMemo(
    () => sessions.filter((item) => sameChatScope(item.scope, scopeState.scope)),
    [scopeState.scope, sessions],
  );

  useEffect(() => {
    if (!hydrated || scopeState.loading || creatingNew) return;
    const active = sessions.find((item) => item.id === activeSessionId);
    if (active && sameChatScope(active.scope, scopeState.scope)) {
      setModelSelection((current) => normalizeChatModelSelection(models, current.model ? current : {
        model: active.model,
        reasoningEffort: active.reasoningEffort,
      }));
      return;
    }
    const next = sessions.find((item) => sameChatScope(item.scope, scopeState.scope));
    if (next) {
      setActiveSessionId(next.id);
      sessionKey.current = next.id;
      setMessages(next.messages);
      setCategory(isCategory(next.category) ? next.category : "General");
      setModelSelection(normalizeChatModelSelection(models, {
        model: next.model,
        reasoningEffort: next.reasoningEffort,
      }));
    } else {
      setActiveSessionId("");
      sessionKey.current = "";
      setMessages([]);
      setDraft("");
      setError("");
    }
  }, [activeSessionId, creatingNew, hydrated, models, scopeState.loading, scopeState.scope, sessions]);

  const addSourceHref = useMemo(() => {
    const query = new URLSearchParams({ panel: "connections" });
    if (scopeState.scope.orgId) query.set("orgId", scopeState.scope.orgId);
    if (scopeState.scope.projectId) query.set("projectId", scopeState.scope.projectId);
    return `/integrations?${query.toString()}`;
  }, [scopeState.scope.orgId, scopeState.scope.projectId]);

  function persist(
    id: string,
    nextMessages: StoredChatMessage[],
    nextCategory = category,
    storedScope = scopeState.scope,
    selection = modelSelection,
  ) {
    const next: StoredChatSession = {
      id,
      title: sessionTitle(nextMessages),
      category: nextCategory,
      scope: { ...storedScope },
      messages: nextMessages,
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      updatedAt: new Date().toISOString(),
    };
    setSessions((current) => {
      const updated = upsertChatSession(current, next);
      saveChatSessions(window.localStorage, updated);
      return updated;
    });
  }

  async function sendMessage() {
    const content = draft.trim();
    if (!content || sending) return;
    const requestScope = { ...scopeState.scope };
    const requestSelection = { ...modelSelection };
    const id = activeSessionId || nextId("dashboard_chat");
    const userMessage: StoredChatMessage = { id: nextId("user"), role: "user", content };
    const history = [...messages, userMessage];
    if (!activeSessionId) setActiveSessionId(id);
    setCreatingNew(false);
    sessionKey.current = id;
    setMessages(history);
    persist(id, history, category, requestScope, requestSelection);
    setDraft("");
    setSending(true);
    setError("");
    try {
      const result = await brainApi.chat(
        history.slice(-20).map(({ role, content: text }) => ({ role, content: text })),
        id,
        requestScope,
        requestSelection,
      );
      if (result.message?.role !== "assistant" || !result.message.content?.trim()) {
        throw new Error("The agent returned an empty response");
      }
      const completed: StoredChatMessage[] = [...history, {
        ...result.message,
        id: nextId("assistant"),
        citations: result.citations ?? [],
        recallStrategy: result.recallStrategy,
      }];
      persist(id, completed, category, requestScope, requestSelection);
      if (sameChatScope(requestScope, currentScope.current)) setMessages(completed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The agent could not answer");
    } finally {
      setSending(false);
    }
  }

  function newConversation() {
    setCreatingNew(true);
    setActiveSessionId("");
    sessionKey.current = "";
    setMessages([]);
    setDraft("");
    setError("");
    requestAnimationFrame(() => composer.current?.focus());
  }

  function openSession(item: StoredChatSession) {
    setCreatingNew(false);
    setActiveSessionId(item.id);
    sessionKey.current = item.id;
    setMessages(item.messages);
    setCategory(isCategory(item.category) ? item.category : "General");
    setModelSelection(normalizeChatModelSelection(models, {
      model: item.model,
      reasoningEffort: item.reasoningEffort,
    }));
    setDraft("");
    setError("");
  }

  function removeSession(id: string) {
    const updated = sessions.filter((item) => item.id !== id);
    setSessions(updated);
    saveChatSessions(window.localStorage, updated);
    if (activeSessionId === id) newConversation();
  }

  function selectCategory(next: ChatCategory) {
    setCategory(next);
    if (activeSessionId && messages.length) persist(activeSessionId, messages, next);
  }

  const activeModel = models.find((model) => model.id === modelSelection.model && model.enabled) ?? null;
  const effortOptions = activeModel?.reasoning?.mode === "selectable" ? activeModel.reasoning.allowed : [];
  const activeOrg = scopeState.orgs.find((org) => org.orgId === scopeState.scope.orgId);
  const canManageModels = Boolean(activeOrg?.capabilities.includes("models:manage"));
  const modelsEmpty = !modelsLoading && !modelsError && models.length === 0;

  function selectModel(model: string) {
    const next = normalizeChatModelSelection(models, { model });
    setModelSelection(next);
    if (activeSessionId && messages.length) persist(activeSessionId, messages, category, scopeState.scope, next);
  }

  function selectEffort(reasoningEffort: ChatModelSelection["reasoningEffort"]) {
    const next = normalizeChatModelSelection(models, { model: modelSelection.model, reasoningEffort });
    setModelSelection(next);
    if (activeSessionId && messages.length) persist(activeSessionId, messages, category, scopeState.scope, next);
  }

  function moveCategory(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % categories.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + categories.length) % categories.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = categories.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = categories[nextIndex];
    selectCategory(next);
    requestAnimationFrame(() => document.getElementById(`chat-category-${next.toLowerCase()}`)?.focus());
  }

  return (
    <div className="chat-workbench">
      <aside className="chat-session-rail" aria-label="Chat sessions">
        <div className="chat-session-rail__head">
          <div><strong>Sessions</strong><span>Saved in this browser</span></div>
          <button type="button" onClick={newConversation} aria-label="New task" title="New task">+</button>
        </div>
        <div className="chat-session-list">
          {!hydrated || scopeState.loading ? <InlineLoading label="Loading sessions…" />
            : scopedSessions.length === 0 ? <span className="chat-session-empty">No tasks in this scope yet.</span>
              : scopedSessions.map((item) => (
                <div className={`chat-session-item${activeSessionId === item.id ? " active" : ""}`} key={item.id}>
                  <button type="button" onClick={() => openSession(item)} aria-current={activeSessionId === item.id ? "page" : undefined}>
                    <strong>{item.title}</strong>
                    <span>{item.category} · {new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                  </button>
                  <button type="button" className="chat-session-remove" aria-label={`Remove ${item.title}`} title="Remove session" onClick={() => removeSession(item.id)}>×</button>
                </div>
              ))}
        </div>
      </aside>

      <div className={`chat-page${messages.length ? " chat-page--active" : ""}`}>
        <div className="chat-hero">
          <header className="chat-heading">
            <div>
              <span className="chat-eyebrow">Agent workbench · {category}</span>
              <h1>{messages.length ? sessionTitle(messages) : "What should we move forward?"}</h1>
            </div>
            {messages.length > 0 && <button type="button" className="chat-new-button" onClick={newConversation}>New task</button>}
          </header>

          {messages.length > 0 && (
            <section className="chat-thread" aria-live="polite" aria-label="Conversation">
              {messages.map((item) => (
                <article className={`chat-message chat-message--${item.role}`} key={item.id}>
                  <div className="chat-message__role">{item.role === "user" ? "You" : "Agent"}</div>
                  <div className="chat-message__body markdown-content markdown-content--chat"><LazyMarkdown>{item.content}</LazyMarkdown></div>
                  {item.citations && item.citations.length > 0 && (
                    <div className="chat-citations">
                      <span>Context used</span>
                      {item.citations.map((citation, index) => (
                        <div className="chat-citation" key={`${citation.recordId}-${index}`}>
                          <strong>{citation.title || citation.type?.replace(/_/g, " ") || `Memory ${index + 1}`}</strong>
                          <p>{citation.excerpt}</p>
                          {typeof citation.score === "number" && <small>{Math.round(citation.score * 100)}% match</small>}
                        </div>
                      ))}
                    </div>
                  )}
                  {item.recallStrategy && <div className="chat-message__meta">Recall: {item.recallStrategy}</div>}
                </article>
              ))}
              {sending && <div className="chat-thinking"><span /><span /><span /> Recalling context and working on the answer</div>}
              <div ref={threadEnd} />
            </section>
          )}

          <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
            <textarea
              ref={composer}
              aria-label="Message BrainRouter"
              placeholder="Ask about your work, recall context, or start an agent task…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="chat-composer__footer">
              <Link href={addSourceHref} className="chat-round-button" aria-label="Add a source" title="Add a source">+</Link>
              <button type="button" className={`chat-context-button${showScope ? " active" : ""}`} aria-expanded={showScope} onClick={() => setShowScope((current) => !current)}>Context</button>
              <span className="chat-scope-summary">{scopeState.projects.find((project) => project.projectId === scopeState.scope.projectId)?.name ?? scopeState.orgs.find((org) => org.orgId === scopeState.scope.orgId)?.name ?? "Personal"}</span>
              <span className="chat-composer__spacer" />
              <label className="chat-runtime-select">
                <span className="sr-only">Model</span>
                <select aria-label="Model" value={modelSelection.model} disabled={modelsLoading || models.length === 0} onChange={(event) => selectModel(event.target.value)}>
                  {modelsLoading ? <option value="">Loading models…</option>
                    : models.length === 0 ? <option value="">No managed models</option>
                      : models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </label>
              <label className="chat-runtime-select chat-runtime-select--effort">
                <span className="sr-only">Reasoning effort</span>
                <select
                  aria-label="Reasoning effort"
                  value={modelSelection.reasoningEffort}
                  disabled={!activeModel || activeModel.reasoning?.mode !== "selectable" || effortOptions.length === 0}
                  onChange={(event) => selectEffort(event.target.value as ChatModelSelection["reasoningEffort"])}
                >
                  <option value="">{activeModel?.reasoning?.mode === "adaptive" ? "Adaptive" : "Automatic"}</option>
                  {effortOptions.map((effort) => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
                </select>
              </label>
              <button type="submit" className="chat-round-button chat-send-button" aria-label="Send message" disabled={!draft.trim() || sending || modelsLoading || !activeModel}>↑</button>
            </div>
            {showScope && <KnowledgeScopePicker state={scopeState} compact />}
          </form>

          {modelsError && <div className="chat-model-error" role="status">Managed models unavailable. <Link href="/providers">Open Models &amp; providers</Link></div>}
          {modelsEmpty && (
            <div className="chat-model-error" role="status">
              No managed model is available for {activeOrg?.name ?? "this organization"}. {canManageModels
                ? <Link href="/providers">Configure a model</Link>
                : <>Choose another organization under Context, or ask an organization administrator to configure one.</>}
            </div>
          )}
          {error && <div className="chat-error" role="alert"><span>Message not sent.</span> {error}</div>}
          {!messages.length && (
            <>
              <div className="chat-categories" role="tablist" aria-label="Conversation category">
                {categories.map((item, index) => (
                  <button
                    type="button"
                    role="tab"
                    id={`chat-category-${item.toLowerCase()}`}
                    aria-controls="chat-suggestions"
                    aria-selected={category === item}
                    tabIndex={category === item ? 0 : -1}
                    className={category === item ? "active" : ""}
                    onKeyDown={(event) => moveCategory(event, index)}
                    onClick={() => selectCategory(item)}
                    key={item}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <div id="chat-suggestions" className="chat-suggestions" role="tabpanel" aria-labelledby={`chat-category-${category.toLowerCase()}`}>
                {suggestions[category].map(([title, description]) => <button type="button" key={title} onClick={() => { setDraft(description); requestAnimationFrame(() => composer.current?.focus()); }}><strong>{title}</strong><span>{description}</span></button>)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  return <AuthGuard><ChatContent /></AuthGuard>;
}
