/**
 * Per-model brand icon — detects a model's FAMILY from its id (claude-opus-4-8 →
 * Claude, gpt-5.5 → OpenAI, qwen2.5-coder → Qwen, z-ai/glm-5.2 → GLM, …) and
 * renders the real lobehub mono mark (from @lobehub/icons-static-svg, imported
 * `?raw`). The marks are `currentColor`, so they inherit the surrounding text
 * color and read in both themes. An unrecognized id falls back to a neutral
 * placeholder so every row still aligns. Used in the composer's model menu.
 */
import React from 'react';
import { modelFamily } from '../../lib/models/modelFamily.js';
import openaiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import claudeSvg from '@lobehub/icons-static-svg/icons/claude.svg?raw';
import geminiSvg from '@lobehub/icons-static-svg/icons/gemini.svg?raw';
import gemmaSvg from '@lobehub/icons-static-svg/icons/gemma.svg?raw';
import qwenSvg from '@lobehub/icons-static-svg/icons/qwen.svg?raw';
import deepseekSvg from '@lobehub/icons-static-svg/icons/deepseek.svg?raw';
import mistralSvg from '@lobehub/icons-static-svg/icons/mistral.svg?raw';
import metaSvg from '@lobehub/icons-static-svg/icons/meta.svg?raw';
import chatglmSvg from '@lobehub/icons-static-svg/icons/chatglm.svg?raw';
import grokSvg from '@lobehub/icons-static-svg/icons/grok.svg?raw';
import cohereSvg from '@lobehub/icons-static-svg/icons/cohere.svg?raw';
import microsoftSvg from '@lobehub/icons-static-svg/icons/microsoft.svg?raw';
import yiSvg from '@lobehub/icons-static-svg/icons/yi.svg?raw';
import kimiSvg from '@lobehub/icons-static-svg/icons/kimi.svg?raw';
import moonshotSvg from '@lobehub/icons-static-svg/icons/moonshot.svg?raw';
import nvidiaSvg from '@lobehub/icons-static-svg/icons/nvidia.svg?raw';
import minimaxSvg from '@lobehub/icons-static-svg/icons/minimax.svg?raw';
import doubaoSvg from '@lobehub/icons-static-svg/icons/doubao.svg?raw';
import baichuanSvg from '@lobehub/icons-static-svg/icons/baichuan.svg?raw';
import perplexitySvg from '@lobehub/icons-static-svg/icons/perplexity.svg?raw';
import hunyuanSvg from '@lobehub/icons-static-svg/icons/hunyuan.svg?raw';

const FAMILY_SVG: Record<string, string> = {
  openai: openaiSvg, claude: claudeSvg, gemini: geminiSvg, gemma: gemmaSvg, qwen: qwenSvg,
  deepseek: deepseekSvg, mistral: mistralSvg, meta: metaSvg, chatglm: chatglmSvg, grok: grokSvg,
  cohere: cohereSvg, microsoft: microsoftSvg, yi: yiSvg, kimi: kimiSvg, moonshot: moonshotSvg,
  nvidia: nvidiaSvg, minimax: minimaxSvg, doubao: doubaoSvg, baichuan: baichuanSvg,
  perplexity: perplexitySvg, hunyuan: hunyuanSvg,
};

// The model-family detector moved to lib/models/modelFamily so it can be reused
// by reasoningProfile without pulling these React/`?raw` imports. Re-exported
// here for back-compat with existing `import { modelFamily } from './ModelIcon'`.
export { modelFamily };

export function ModelIcon({ model, size = 15, style }: { model: string; size?: number; style?: React.CSSProperties }): React.ReactElement {
  const fam = modelFamily(model);
  const raw = fam ? FAMILY_SVG[fam] : null;
  const base: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flex: '0 0 auto' };
  if (raw) {
    // The lobehub mark is `1em` + `currentColor`; font-size drives its size and
    // it inherits the row's text color.
    return <span aria-hidden style={{ ...base, fontSize: size, lineHeight: 0, ...style }} dangerouslySetInnerHTML={{ __html: raw }} />;
  }
  return (
    <span aria-hidden style={{ ...base, opacity: 0.45, ...style }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="4.5" /><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" /></svg>
    </span>
  );
}
