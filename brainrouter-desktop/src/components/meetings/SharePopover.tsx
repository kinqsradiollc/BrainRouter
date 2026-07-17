import { useEffect, useRef, useState, type ReactElement } from "react";
import { groupTeamOptions, teamCreateTargetFor, type TeamContext, type TeamOption, type TeamsOps } from "./teamsOps.js";
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
  teamsOps: TeamsOps;
  teamRevision?: number;
  /** The organization context selected on the meetings surface. Team listing and
   *  inline create both target this context so an org meeting shares to that
   *  org's teams. */
  context?: TeamContext;
  onError(message: string): void;
  onSetScope(scope: MeetingScope, opts?: { teamId?: string }): void;
}

/** Header "Share" button + a scope popover (ADR-018 D8). Public reveals a
 *  revocable link; Team reveals a picker of the caller's teams. */
export function SharePopover({ share, busy, teamsOps, teamRevision = 0, context, onError, onSetScope }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  // Selecting the Team row reveals the picker without committing a team-less scope.
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
  // null = teams not yet fetched; loaded lazily on first open of the picker.
  const [teams, setTeams] = useState<TeamOption[] | null>(null);
  const [newTeamName, setNewTeamName] = useState("");
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const orgId = context?.orgId;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // A changed org selection (or team edit) invalidates the cached team list for
  // the previously selected context.
  useEffect(() => { setTeams(null); }, [orgId, teamRevision]);

  // The picker shows for an already team-shared meeting, or once the Team row is
  // picked. Fetch the selected context's teams the first time it becomes visible
  // — most meetings never get team-shared, so we don't fetch on load.
  const showTeamPicker = teamPickerOpen || share.scope === "team";
  useEffect(() => {
    if (!open || !showTeamPicker || teams !== null) return;
    let live = true;
    void teamsOps.list(orgId).then((t) => { if (live) setTeams(t); }).catch((caught) => {
      if (!live) return;
      setTeams([]);
      onError(caught instanceof Error ? caught.message : "Could not load teams.");
    });
    return () => { live = false; };
  }, [onError, open, orgId, showTeamPicker, teams, teamsOps]);

  const grouped = teams === null ? null : groupTeamOptions(teams);
  // The inline "New team" create lands in the SELECTED context, so an org meeting
  // shares to that org's teams. A missing/personal context degrades to personal.
  const createTarget = teamCreateTargetFor(context);
  const orgHeaderName = createTarget.kind === "organization" ? createTarget.orgName : grouped?.organization[0]?.orgName ?? null;

  const submitCreate = async (): Promise<void> => {
    const name = newTeamName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const created = await teamsOps.create(name, createTarget.kind, createTarget.orgId ?? undefined);
      const row = !created.orgName && createTarget.orgName ? { ...created, orgName: createTarget.orgName } : created;
      setNewTeamName("");
      setTeams((rows) => rows ? [...rows.filter((item) => item.id !== row.id), row] : [row]);
      onSetScope("team", { teamId: created.id });
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Could not create the team.");
    } finally {
      setCreating(false);
    }
  };

  const teamRow = (t: TeamOption): ReactElement => {
    const on = share.scope === "team" && share.teamId === t.id;
    return (
      <button
        type="button"
        key={t.id}
        className={`mv-trow${on ? " mv-on" : ""}`}
        role="menuitemradio"
        aria-checked={on}
        onClick={() => onSetScope("team", { teamId: t.id })}
      >
        <span className="mv-tnm">{t.name}<small>{t.kind === "personal" ? "Cross-organization · explicit access" : t.orgName ?? "Organization team"}</small></span>
        <span className="mv-ck">{CHECK}</span>
      </button>
    );
  };

  const createRow = (
    <form
      className="mv-tcreate"
      onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}
    >
      <input
        value={newTeamName}
        placeholder="New team"
        aria-label="New team name"
        disabled={creating}
        onChange={(event) => setNewTeamName(event.target.value)}
      />
      <button type="submit" disabled={creating || !newTeamName.trim()}>
        {creating ? "Creating…" : createTarget.kind === "organization" ? `Create team in ${createTarget.orgName}` : "Create personal team"}
      </button>
    </form>
  );

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
              onClick={() => {
                if (scope === "team") { setTeamPickerOpen(true); return; }
                setTeamPickerOpen(false);
                onSetScope(scope);
              }}
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

          {showTeamPicker ? (
            <div className="mv-teamzone">
              {grouped === null ? (
                <div className="mv-teamhint">Loading teams…</div>
              ) : (
                <>
                  <div className="mv-tgroup-h">Organization teams{orgHeaderName ? <small>— {orgHeaderName}</small> : null}</div>
                  {grouped.organization.length === 0 ? (
                    <>
                      <div className="mv-teamhint">
                        {createTarget.kind === "organization"
                          ? `No organization teams in ${createTarget.orgName} yet — create the first one below.`
                          : "No organization teams yet."}
                      </div>
                      {createTarget.kind === "organization" ? createRow : null}
                    </>
                  ) : (
                    grouped.organization.map(teamRow)
                  )}
                  {grouped.personal.length ? (
                    <>
                      <div className="mv-tgroup-h">Personal teams<small>cross-organization · explicit access</small></div>
                      {grouped.personal.map(teamRow)}
                    </>
                  ) : null}
                  {createTarget.kind === "organization" && grouped.organization.length === 0 ? null : createRow}
                </>
              )}
            </div>
          ) : null}

          {share.scope === "public" && share.publicUrl ? (
            <div className="mv-linkzone">
              <div className="mv-linkrow">
                <input value={share.publicUrl} readOnly aria-label="Public share link" />
                <button
                  type="button"
                  className="mv-cp"
                  onClick={() => { void navigator.clipboard?.writeText(share.publicUrl ?? ""); setCopied(true); globalThis.setTimeout(() => setCopied(false), 1400); }}
                >
                  {copied ? "Copied" : "Copy"}
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
