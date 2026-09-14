// ADR-056 D-B1 — the deterministic design detector: rule catalogue, static engine,
// design.md tokens, and workspace suppressions. Node-only (fs, cheerio).
export { DESIGN_RULES, DESIGN_RULE_BY_ID, DESIGN_RULES_VERSION, isDesignRuleId, OVERUSED_FONTS, BUZZWORDS, type DesignRule, type DesignRuleCategory, type DesignRuleSeverity } from './rules.js';
export { detectDesign, normaliseMarkup, type DesignInputFile, type DesignFinding, type DesignDetectOptions, type DesignDetectResult } from './engine.js';
export { parseCss, parseColor, toHex, contrastRatio, lengthPx, type CssSheet, type CssRule, type CssDeclaration, type Rgb } from './css.js';
export { readDesignSystemTokens, parseDesignTokens, primaryFamily, type DesignSystemTokens } from './designSystem.js';
export { readDesignSuppressions, parseDesignSuppressions, isSuppressed, globMatch, DESIGN_SUPPRESSIONS_FILE, EMPTY_SUPPRESSIONS, type DesignSuppressions, type DesignSuppressionValue } from './suppressions.js';
export { collectDesignFiles, DESIGN_FILE_LIMITS } from './files.js';
