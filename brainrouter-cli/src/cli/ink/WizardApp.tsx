/**
 * Barrel for the Ink-based setup wizard. The implementation lives in
 * cohesive sibling modules under ./wizard-app/ (component, steps,
 * shared helpers, MCP probe). This file preserves the original public
 * surface: `WizardApp` + `WizardAppProps`.
 */
export { WizardApp } from './wizard-app/component.js';
export type { WizardAppProps } from './wizard-app/component.js';
