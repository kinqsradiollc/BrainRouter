import React, { useMemo, useState } from 'react';
import {
  buildPrototypePrompt,
  buildDesignSteering,
  isHexColor,
  reservePrototypePath,
  type DesignContext,
} from '@kinqs/brainrouter-core/prototype';

/**
 * INTERACTIVE PROTOTYPE (§3 D4) — the design-context editor + prompt composer.
 * Set a requirement and a {designType, brandColor, tone[]} steer; this builds the
 * exact prompt the agent follows to emit one self-contained interactive HTML file
 * at a reserved path (pure core: buildPrototypePrompt + buildDesignSteering +
 * reservePrototypePath). Copy it into chat to generate — the result lands as an
 * html artifact, which the Artifacts panel renders (placeholder swap from §3 D2).
 */

const TONES = ['minimal', 'playful', 'professional', 'bold', 'elegant', 'high-contrast', 'retro', 'dark'];

export function PrototypePanel(): React.ReactElement {
  const [requirement, setRequirement] = useState('A kanban board with drag-and-drop columns and add-card.');
  const [designType, setDesignType] = useState('');
  const [brandColor, setBrandColor] = useState('');
  const [tone, setTone] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  // A stable-per-session reserved path so the preview prompt doesn't churn every render.
  const reservedPath = useMemo(() => {
    const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    return reservePrototypePath(Date.now(), hex);
  }, []);

  const design: DesignContext = {
    designType: designType.trim() || undefined,
    brandColor: brandColor.trim() || undefined,
    tone: tone.length ? tone : undefined,
  };
  const steering = buildDesignSteering(design);
  const prompt = buildPrototypePrompt({ requirement, reservedPath, design });

  const colorValid = !brandColor.trim() || isHexColor(brandColor);
  const toggleTone = (t: string): void => setTone((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const copyPrompt = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  return (
    <div className="scroll proto-panel">
      <label className="wf-field">Requirement
        <textarea className="wf-textarea" rows={3} value={requirement} onChange={(e) => setRequirement(e.target.value)} placeholder="What should the prototype do?" />
      </label>

      <div className="proto-section">Design context</div>
      <label className="wf-field">Type
        <input className="filter" value={designType} onChange={(e) => setDesignType(e.target.value)} placeholder="dashboard · landing page · mobile app…" />
      </label>
      <label className="wf-field">Brand color
        <div className="proto-color">
          <input className="filter" value={brandColor} onChange={(e) => setBrandColor(e.target.value)} placeholder="#4f46e5" />
          {brandColor.trim() && colorValid ? <span className="proto-swatch" style={{ background: brandColor }} /> : null}
          {!colorValid ? <span className="proto-warn">not a hex color</span> : null}
        </div>
      </label>
      <div className="wf-field">Tone
        <div className="proto-tones">
          {TONES.map((t) => (
            <button key={t} type="button" className={`proto-tone${tone.includes(t) ? ' on' : ''}`} onClick={() => toggleTone(t)}>{t}</button>
          ))}
        </div>
      </div>

      {steering ? <pre className="proto-steering">{steering}</pre> : <div className="sched-note">Add a type, brand color, or tone to steer the look & feel.</div>}

      <div className="proto-actions">
        <span className="proto-path">→ {reservedPath}</span>
        <button className="sched-add-btn" disabled={!requirement.trim()} onClick={() => void copyPrompt()}>{copied ? 'Copied ✓' : 'Copy prompt'}</button>
      </div>

      <div className="proto-section">Prototype prompt</div>
      <pre className="proto-prompt">{prompt}</pre>

      <div className="sched-note">Paste this into chat to generate. The agent writes one self-contained interactive HTML file to the reserved path; it lands as an <code>html</code> artifact (placeholder tokens resolve to inline SVGs in the Artifacts preview).</div>
    </div>
  );
}
