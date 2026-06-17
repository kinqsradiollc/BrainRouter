/**
 * Button — the shared `.wt-btn` control primitive (Button/Badge consolidation).
 * Renders a real <button> with the variant class composed by buttonClass, so
 * every panel button has one definition to restyle. Behavior-preserving: the
 * emitted class is identical to the old inline `className="wt-btn …"` strings.
 * All native button props (onClick/disabled/title/type/…) pass straight through.
 */
import React from 'react';
import { buttonClass, type ButtonVariant } from '../lib/ui/controlClass.js';

export function Button({ variant = 'default', className, type = 'button', ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): React.ReactElement {
  return <button type={type} className={buttonClass(variant, className)} {...rest} />;
}
