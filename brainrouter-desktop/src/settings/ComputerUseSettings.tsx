import React, { useState } from 'react';
import { Row, Toggle, ChoiceControl } from './controls.js';

export function ComputerUseSettings({ knobs, refreshSnapshot }: { knobs: Record<string, unknown>; refreshSnapshot: () => void }): React.ReactElement {
  const cfg = (knobs.computerUse && typeof knobs.computerUse === 'object' ? knobs.computerUse : {}) as { enabled?: boolean; mode?: string };
  const [permissions, setPermissions] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const refreshPermissions = React.useCallback(() => {
    void window.brainrouter.computerUse?.checkPermissions().then(setPermissions).catch(() => setPermissions(null));
  }, []);
  React.useEffect(() => { refreshPermissions(); }, [refreshPermissions]);
  const save = (patch: { enabled?: boolean; mode?: string }): void => {
    setBusy(true);
    void window.brainrouter.computerUse?.setMode({ enabled: cfg.enabled ?? false, mode: cfg.mode ?? 'smart_approve', ...patch })
      .finally(() => {
        setBusy(false);
        refreshSnapshot();
      });
  };
  const accessOk = permissions?.accessibility?.granted !== false;
  const screenOk = permissions?.screen?.granted !== false;
  return (
    <>
      <div className="set-h2">Computer use</div>
      <Row title="Enable computer use" desc="OFF by default. Exposes the shell-tier local tool only in the desktop app when the native host is available.">
        <Toggle on={cfg.enabled === true} onChange={(v) => save({ enabled: v })} />
      </Row>
      <Row title="Approval mode" desc="Mutating actions still follow the active execution mode; destructive actions always ask.">
        <ChoiceControl
          value={cfg.mode ?? 'smart_approve'}
          options={[
            { value: 'smart_approve', label: 'Smart approve', detail: 'safe actions follow mode' },
            { value: 'approve_all', label: 'Approve all', detail: 'prompt every mutating action' },
            { value: 'full_control', label: 'Full control', detail: 'fast-mode native control' },
          ]}
          onChange={(mode) => save({ mode })}
        />
      </Row>
      <Row title="Native permissions" desc="macOS requires Screen Recording for screenshots and Accessibility for mouse/keyboard control.">
        <div className="pc-actions" style={{ justifyContent: 'flex-end' }}>
          <span className={`pc-tag ${screenOk ? 'ok' : 'danger'}`}>Screen {screenOk ? 'granted' : permissions?.screen?.status ?? 'needed'}</span>
          <span className={`pc-tag ${accessOk ? 'ok' : 'danger'}`}>Accessibility {accessOk ? 'granted' : 'needed'}</span>
          <button className="btn" disabled={busy} onClick={refreshPermissions}>Refresh</button>
          <button className="btn" onClick={() => window.brainrouter.computerUse?.openScreenRecordingSettings()}>Screen</button>
          <button className="btn" onClick={() => window.brainrouter.computerUse?.openAccessibilitySettings()}>Accessibility</button>
        </div>
      </Row>
    </>
  );
}
