import { useEffect, useRef, useState, type ReactElement } from "react";
import { MEETING_SCOPES, SCOPE_BLURB, SCOPE_LABEL, type MeetingScope, type MeetingShare } from "./types.js";

const SCOPE_ICON: Record<MeetingScope, ReactElement> = {
  private: <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
  team: <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6" /></svg>,
  org: <svg viewBox="0 0 24 24"><path d="M3 21h18M6 21V8l6-4 6 4v13M10 12h4M10 16h4" /></svg>,
  public: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></svg>,
};

const CHECK = <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>;

interface Props {
  share: MeetingShare;
  busy?: boolean;
  onSetScope(scope: MeetingScope): void;
}

/** Header "Share" button + a scope popover (ADR-018 D8). Public reveals a revocable link. */
export function SharePopover({ share, busy, onSetScope }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="mv-share-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`mv-sharebtn mv-s-${share.scope}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mv-dot" />
        <span>{SCOPE_LABEL[share.scope]}</span>
        <svg className="mv-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
      </button>

      {open ? (
        <div className="mv-pop" role="menu">
          <div className="mv-pop-h">Who can access</div>
          {MEETING_SCOPES.map((scope) => (
            <button
              type="button"
              key={scope}
              className={`mv-srow${share.scope === scope ? " mv-on" : ""}`}
              data-s={scope}
              role="menuitemradio"
              aria-checked={share.scope === scope}
              onClick={() => onSetScope(scope)}
            >
              <span className="mv-ic">{SCOPE_ICON[scope]}</span>
              <span className="mv-sbody">
                <span className="mv-lb">
                  {SCOPE_LABEL[scope]}
                  <span className="mv-ck">{CHECK}</span>
                </span>
                <span className="mv-ds">{SCOPE_BLURB[scope]}</span>
              </span>
            </button>
          ))}

          {share.scope === "public" && share.publicUrl ? (
            <div className="mv-linkzone">
              <div className="mv-linkrow">
                <input value={share.publicUrl} readOnly aria-label="Public share link" />
                <button
                  type="button"
                  className="mv-cp"
                  onClick={() => void navigator.clipboard?.writeText(share.publicUrl ?? "")}
                >
                  Copy
                </button>
              </div>
              <div className="mv-linkmeta">
                <span className="mv-lm">
                  {share.expiresAt ? `Expires ${share.expiresAt} · ` : ""}summary only
                </span>
                <button type="button" className="mv-revoke" onClick={() => onSetScope("private")}>
                  Revoke link
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
