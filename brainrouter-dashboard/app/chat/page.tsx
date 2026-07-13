"use client";

import Link from "next/link";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { KnowledgeScopePicker, useKnowledgeScope } from "../../components/KnowledgeScopePicker";
import { Markdown } from "../../components/Markdown";
import { brainApi, type BrainChatCitation, type BrainChatMessage } from "../../lib/brainApi";

const categories = ["General", "Build", "Plan", "Recall", "Knowledge", "Review"] as const;
type ChatCategory = (typeof categories)[number];
const suggestions: Record<ChatCategory, ReadonlyArray<readonly [string, string]>> = {
  General: [
    ["Move a task forward", "Help me choose the next concrete step for the task in this workspace."],
    ["Understand this project", "Summarize the project, its current state, and the most important open work."],
    ["Prepare useful context", "Assemble the project knowledge and source material that can help with my next task."],
    ["Check recent work", "Review what changed recently and tell me what still needs attention."],
  ],
  Build: [
    ["Plan an implementation", "Turn my requested change into a focused implementation and verification plan."],
    ["Trace a code path", "Find the code path behind the behavior I describe and explain how its parts connect."],
    ["Diagnose a failure", "Use the available project context to narrow down the cause of a failing behavior."],
    ["Prepare a verification pass", "List the highest-value checks for the change I am about to make."],
  ],
  Plan: [
    ["Break down an outcome", "Turn my goal into ordered milestones, dependencies, and concrete next actions."],
    ["Prioritize the backlog", "Help me rank the current work by impact, urgency, and dependency risk."],
    ["Surface missing decisions", "Identify the product or technical decisions that are still blocking progress."],
    ["Draft acceptance criteria", "Write measurable acceptance criteria for the task I am planning."],
  ],
  Recall: [
    ["Inspect recent recalls", "Show which saved context has been most useful in my latest agent sessions."],
    ["Explain a recall", "Trace why a memory was selected and which signals affected its score."],
    ["Find an earlier decision", "Recall the decision related to the topic I describe and include its evidence."],
    ["Prepare agent context", "Assemble the most relevant recalled context for the task I am starting next."],
  ],
  Knowledge: [
    ["Inspect saved knowledge", "Show what BrainRouter captured from my latest agent sessions and connected sources."],
    ["Find source evidence", "Find the source material that supports what BrainRouter knows about the topic I describe."],
    ["Resolve contradictions", "Find conflicting facts and help me choose the current source of truth."],
    ["Find a knowledge gap", "Show where the selected project or workspace is missing useful durable context."],
  ],
  Review: [
    ["Review recent changes", "Assess the latest project changes for correctness, regressions, and missing tests."],
    ["Check delivery readiness", "Tell me what evidence is still missing before this work is ready to ship."],
    ["Summarize review findings", "Group the latest review findings by severity and recommended next action."],
    ["Verify an outcome", "Build a concise verification checklist for the outcome I describe."],
  ],
};

interface ConversationMessage extends BrainChatMessage {
  id: string;
  citations?: BrainChatCitation[];
  recallStrategy?: string;
}

function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ChatContent() {
  const scopeState = useKnowledgeScope();
  const [category, setCategory] = useState<ChatCategory>("General");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [showScope, setShowScope] = useState(false);
  const sessionKey = useRef("");
  const threadEnd = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { threadEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, sending]);

  const addSourceHref = useMemo(() => {
    const query = new URLSearchParams({ panel: "connections" });
    if (scopeState.scope.orgId) query.set("orgId", scopeState.scope.orgId);
    if (scopeState.scope.projectId) query.set("projectId", scopeState.scope.projectId);
    return `/integrations?${query.toString()}`;
  }, [scopeState.scope.orgId, scopeState.scope.projectId]);

  async function sendMessage() {
    const content = draft.trim();
    if (!content || sending) return;
    const userMessage: ConversationMessage = { id: nextId("user"), role: "user", content };
    const history = [...messages, userMessage].map(({ role, content: text }) => ({ role, content: text }));
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setSending(true);
    setError("");
    if (!sessionKey.current) sessionKey.current = nextId("dashboard_chat");
    try {
      const result = await brainApi.chat(history.slice(-20), sessionKey.current, scopeState.scope);
      if (result.message?.role !== "assistant" || !result.message.content?.trim()) {
        throw new Error("The agent returned an empty response");
      }
      setMessages((current) => [...current, {
        ...result.message,
        id: nextId("assistant"),
        citations: result.citations ?? [],
        recallStrategy: result.recallStrategy,
      }]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The agent could not answer");
    } finally {
      setSending(false);
    }
  }

  function newConversation() {
    setMessages([]);
    setDraft("");
    setError("");
    sessionKey.current = "";
  }

  function selectCategory(next: ChatCategory) {
    setCategory(next);
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

  function chooseSuggestion(prompt: string) {
    setDraft(prompt);
    requestAnimationFrame(() => composer.current?.focus());
  }

  return (
    <div className={`chat-page${messages.length ? " chat-page--active" : ""}`}>
      <div className="chat-hero">
        <header className="chat-heading">
          <div>
            <span className="chat-eyebrow">Agent workbench · {category}</span>
            <h1>{messages.length ? "Continue the task" : "What should we move forward?"}</h1>
          </div>
          {messages.length > 0 && <button type="button" className="chat-new-button" onClick={newConversation}>New conversation</button>}
        </header>

        {messages.length > 0 && (
          <section className="chat-thread" aria-live="polite" aria-label="Conversation">
            {messages.map((item) => (
              <article className={`chat-message chat-message--${item.role}`} key={item.id}>
                <div className="chat-message__role">{item.role === "user" ? "You" : "Agent"}</div>
                <div className="chat-message__body markdown-content markdown-content--chat"><Markdown>{item.content}</Markdown></div>
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
            <button type="button" className={`chat-context-button${showScope ? " active" : ""}`} aria-expanded={showScope} onClick={() => setShowScope((current) => !current)}>Context scope</button>
            <span className="chat-scope-summary">{scopeState.projects.find((project) => project.projectId === scopeState.scope.projectId)?.name ?? scopeState.orgs.find((org) => org.orgId === scopeState.scope.orgId)?.name ?? "Personal"}</span>
            <button type="submit" className="chat-round-button chat-send-button" aria-label="Send message" disabled={!draft.trim() || sending}>↑</button>
          </div>
          {showScope && <KnowledgeScopePicker state={scopeState} compact />}
        </form>

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
              {suggestions[category].map(([title, description]) => <button type="button" key={title} onClick={() => chooseSuggestion(description)}><strong>{title}</strong><span>{description}</span></button>)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function ChatPage() {
  return <AuthGuard><ChatContent /></AuthGuard>;
}
