"use client";

/**
 * ADR-032 Q4 — explicit hosted human-correction form.
 *
 * This is intentionally separate from chat: a person must choose the trusted
 * action and provide a statement, falsifier, and expected outcome before an
 * instruction-tier lesson can be considered by the server gate.
 */
import React, { useState, type FormEvent } from "react";
import { PremiumButton } from "../../components/PremiumButton";
import { PremiumCard } from "../../components/PremiumCard";
import {
  HOSTED_CORRECTION_LIMITS,
  hostedHumanCorrectionErrors,
  normalizeHostedHumanCorrection,
  type HostedHumanCorrectionErrors,
  type HostedHumanCorrectionInput,
} from "../../lib/learnedBehaviors";

const EMPTY_CORRECTION: HostedHumanCorrectionInput = {
  sessionKey: "",
  statement: "",
  falsifier: "",
  expectation: "",
};

interface HumanCorrectionFormProps {
  activeOrgName: string;
  busy: boolean;
  requestError: string;
  onCancel: () => void;
  onEdit: () => void;
  onSubmit: (input: HostedHumanCorrectionInput) => Promise<void>;
}

function FieldError({ id, error }: { id: string; error: string | undefined }) {
  return error ? <span id={id} role="alert" style={{ display: "block", marginTop: "6px", color: "var(--danger)" }}>{error}</span> : null;
}

export function HumanCorrectionForm({
  activeOrgName,
  busy,
  requestError,
  onCancel,
  onEdit,
  onSubmit,
}: HumanCorrectionFormProps) {
  const [draft, setDraft] = useState<HostedHumanCorrectionInput>(EMPTY_CORRECTION);
  const [errors, setErrors] = useState<HostedHumanCorrectionErrors>({});

  function update(field: keyof HostedHumanCorrectionInput, value: string): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    onEdit();
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextErrors = hostedHumanCorrectionErrors(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    void onSubmit(normalizeHostedHumanCorrection(draft));
  }

  return (
    <PremiumCard level={2} style={{ padding: "20px" }}>
      <form id="human-correction-form" noValidate aria-labelledby="human-correction-title" onSubmit={submit} style={{ display: "grid", gap: "16px" }}>
        <div>
          <h2 id="human-correction-title" style={{ margin: 0, color: "var(--text)", fontSize: "18px" }}>
            Record a human correction
          </h2>
          <p style={{ margin: "7px 0 0", color: "var(--text-secondary)", fontSize: "13px", lineHeight: 1.55 }}>
            This explicit action submits a trusted instruction candidate for <strong>{activeOrgName}</strong>.
            Ordinary chat messages never create instruction-tier learned behavior.
          </p>
        </div>

        <label className="settings-label" htmlFor="correction-session-key">
          Session key
          <span id="correction-session-key-help" className="settings-hint" style={{ display: "block", marginTop: "4px" }}>
            The chat or agent session this correction applies to. Letters, numbers, dots, underscores, colons, and hyphens only.
          </span>
          <input
            id="correction-session-key"
            autoFocus
            autoComplete="off"
            className="settings-input"
            maxLength={HOSTED_CORRECTION_LIMITS.sessionKey}
            value={draft.sessionKey}
            aria-invalid={Boolean(errors.sessionKey)}
            aria-describedby={`correction-session-key-help${errors.sessionKey ? " correction-session-key-error" : ""}`}
            onChange={(event) => update("sessionKey", event.target.value)}
            placeholder="chat_1720000000000_ab12cd"
          />
          <FieldError id="correction-session-key-error" error={errors.sessionKey} />
        </label>

        <label className="settings-label" htmlFor="correction-statement">
          What should BrainRouter do differently?
          <textarea
            id="correction-statement"
            className="settings-textarea"
            rows={3}
            maxLength={HOSTED_CORRECTION_LIMITS.text}
            value={draft.statement}
            aria-invalid={Boolean(errors.statement)}
            aria-describedby={`correction-statement-count${errors.statement ? " correction-statement-error" : ""}`}
            onChange={(event) => update("statement", event.target.value)}
            placeholder="Use the repository's release branch as the comparison base for readiness reviews."
          />
          <span id="correction-statement-count" className="settings-hint">{draft.statement.length}/{HOSTED_CORRECTION_LIMITS.text}</span>
          <FieldError id="correction-statement-error" error={errors.statement} />
        </label>

        <label className="settings-label" htmlFor="correction-falsifier">
          What observable result would prove this wrong?
          <textarea
            id="correction-falsifier"
            className="settings-textarea"
            rows={3}
            maxLength={HOSTED_CORRECTION_LIMITS.text}
            value={draft.falsifier}
            aria-invalid={Boolean(errors.falsifier)}
            aria-describedby={`correction-falsifier-count${errors.falsifier ? " correction-falsifier-error" : ""}`}
            onChange={(event) => update("falsifier", event.target.value)}
            placeholder="The task explicitly names another base branch, or the release branch no longer exists."
          />
          <span id="correction-falsifier-count" className="settings-hint">{draft.falsifier.length}/{HOSTED_CORRECTION_LIMITS.text}</span>
          <FieldError id="correction-falsifier-error" error={errors.falsifier} />
        </label>

        <label className="settings-label" htmlFor="correction-expectation">
          What improvement should this produce?
          <textarea
            id="correction-expectation"
            className="settings-textarea"
            rows={3}
            maxLength={HOSTED_CORRECTION_LIMITS.text}
            value={draft.expectation}
            aria-invalid={Boolean(errors.expectation)}
            aria-describedby={`correction-expectation-count${errors.expectation ? " correction-expectation-error" : ""}`}
            onChange={(event) => update("expectation", event.target.value)}
            placeholder="Readiness reports compare the intended change set and stop flagging unrelated branch history."
          />
          <span id="correction-expectation-count" className="settings-hint">{draft.expectation.length}/{HOSTED_CORRECTION_LIMITS.text}</span>
          <FieldError id="correction-expectation-error" error={errors.expectation} />
        </label>

        {requestError && <div role="alert" className="settings-note settings-note--error" style={{ margin: 0 }}>{requestError}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
          <PremiumButton variant="ghost" disabled={busy} onClick={onCancel}>Cancel</PremiumButton>
          <PremiumButton type="submit" variant="primary" disabled={busy}>
            {busy ? "Recording…" : "Record correction"}
          </PremiumButton>
        </div>
      </form>
    </PremiumCard>
  );
}
