/**
 * Provider brand marks for the Models settings panel — the real @lobehub/icons
 * artwork, sourced from the dependency-free `@lobehub/icons-static-svg` asset
 * package (MIT). The React component package (`@lobehub/icons`) can't install
 * here — its current line hard-requires React 19 + the heavy `@lobehub/ui`/
 * `antd` — so we pull the static SVGs instead. Each provider's monochrome mark
 * is imported as raw SVG (Vite `?raw`) and rendered WHITE via its `currentColor`
 * fill on a rounded chip in the provider's signature brand color, so a logo
 * always reads clearly in both themes with no theme.css rule. Providers without
 * a lobehub mark (opencode, the generic OpenAI-compatible option, unknown ids)
 * fall back to a plug glyph or a lettered avatar so nothing renders blank.
 */
import React from 'react';
import openaiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import claudeSvg from '@lobehub/icons-static-svg/icons/claude.svg?raw';
import geminiSvg from '@lobehub/icons-static-svg/icons/gemini.svg?raw';
import openrouterSvg from '@lobehub/icons-static-svg/icons/openrouter.svg?raw';
import zenmuxSvg from '@lobehub/icons-static-svg/icons/zenmux.svg?raw';
import groqSvg from '@lobehub/icons-static-svg/icons/groq.svg?raw';
import azureSvg from '@lobehub/icons-static-svg/icons/azure.svg?raw';
import ollamaSvg from '@lobehub/icons-static-svg/icons/ollama.svg?raw';
import lmstudioSvg from '@lobehub/icons-static-svg/icons/lmstudio.svg?raw';

/** Raw lobehub mono SVG (currentColor) keyed by catalog provider id. */
const LOGO: Record<string, string> = {
  openai: openaiSvg,
  anthropic: claudeSvg,
  gemini: geminiSvg,
  openrouter: openrouterSvg,
  zenmux: zenmuxSvg,
  groq: groqSvg,
  azure: azureSvg,
  ollama: ollamaSvg,
  lmstudio: lmstudioSvg,
};

/** Brand chip background per provider id (solid color or gradient). */
const BG: Record<string, string> = {
  openai: '#000000',
  anthropic: '#D97757',
  gemini: 'linear-gradient(135deg, #4285F4 0%, #9168F0 100%)',
  openrouter: '#4D5BCE',
  zenmux: '#0D9488',
  groq: '#F55036',
  azure: 'linear-gradient(135deg, #0078D4 0%, #33A0EE 100%)',
  'openai-compatible': '#52525B',
  opencode: '#1F2937',
  lmstudio: '#5B57E0',
  ollama: '#0B1220',
};

/** Lettered avatar text for providers without a lobehub mark. */
const MONOGRAM: Record<string, string> = { opencode: 'oc' };

/** Generic plug glyph for the OpenAI-compatible custom provider. */
const PLUG = (
  <svg width="62%" height="62%" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 13.5 13.5 9M7 16l-1.5 1.5a2.6 2.6 0 0 1-3.7-3.7L4.5 11a2.6 2.6 0 0 1 3.7 0M16 7l1.5-1.5a2.6 2.6 0 0 1 3.7 3.7L18.5 12a2.6 2.6 0 0 1-3.7 0" />
  </svg>
);

export function ProviderIcon({ id, size = 26, title }: { id: string; size?: number; title?: string }): React.ReactElement {
  const known = id in BG || id in LOGO;
  const bg = BG[id] ?? '#3F3F46';
  const raw = LOGO[id];
  return (
    <span
      title={title}
      aria-hidden={!title}
      aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, flex: '0 0 auto', borderRadius: Math.round(size * 0.26),
        background: bg, boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
        // The lobehub marks are `currentColor`; white + this font-size drives
        // their fill and their `1em` size (≈62% of the chip).
        color: '#fff', fontSize: Math.round(size * 0.62), lineHeight: 0,
        opacity: known ? 1 : 0.92,
      }}
    >
      {raw
        ? <span style={{ display: 'inline-flex', lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: raw }} />
        : id === 'openai-compatible'
          ? PLUG
          : <span style={{ fontSize: Math.round(size * 0.42), fontWeight: 700, fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif", lineHeight: 1 }}>{MONOGRAM[id] ?? (id.replace(/[^a-z0-9]/gi, '')[0] ?? '?').toUpperCase()}</span>}
    </span>
  );
}
