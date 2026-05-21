---
name: a11y-skill
description: WCAG 2.1 AA accessibility mandates for the frontend. Use when implementing or reviewing user interface components, form inputs, modals, or motion effects.
hints: |
  - Always use semantic HTML tags (like button, main, nav, section) instead of styled divs.
  - Ensure every interactive element is keyboard-focusable with visible focus-visible indicators.
  - Associate all input fields with clear label tags and connect error messages via aria-describedby.
  - Implement focus-traps for modals and popovers, restoring focus on close.
  - Audit color contrast ratios and respect prefers-reduced-motion media queries for transitions.
---

# Accessibility (A11Y) Skill

## Overview

User interfaces must meet WCAG 2.1 Level AA standards. Accessibility is a first-class citizen in modern interface design, ensuring that apps are robust, accessible, and compliant for all users, including those using assistive technologies.

## Workflow

- **Semantic HTML Only**
  - Use `<button>` for actions, `<a>` for navigation.
  - Never use `div` or `span` for interactive elements without proper ARIA roles and keyboard listeners.
  - Maintain a logical heading hierarchy (`h1` -> `h2` -> `h3`).

- **Interactive Elements**
  - Every interactive element must be keyboard-reachable (Tab) and operable (Enter/Space).
  - Use `aria-label` for icon-only buttons.
  - Never remove focus outlines without providing a high-contrast `:focus-visible` alternative.

- **Forms & Inputs**
  - Every input must have an associated `<label>`.
  - Use `aria-describedby` to link error messages to their respective inputs.
  - Use `aria-invalid="true"` for fields with errors.

- **Visual & Motion**
  - Maintain a 4.5:1 contrast ratio for normal text.
  - Respect `prefers-reduced-motion` for all animations.
  - Do not rely on color alone to convey status (use icons or text labels).

- **Focus Management**
  - Modals must trap focus while open.
  - Focus must return to the triggering element upon modal closure.

## Implementation Pattern (React)

```tsx
<button
  aria-label="Close modal"
  className="focus-visible:ring-2 focus-visible:ring-dd-accent"
  onClick={onClose}
>
  <XIcon aria-hidden="true" />
</button>
```

## When to Use

- Designing, building, or refactoring user interfaces, navigation menus, and page structures.
- Creating interactive components such as modals, dropdowns, popovers, or forms.
- Adding custom styling focus effects, animations, or state indicators.

**When NOT to use:**
- Developing purely headless CLI tools, server backend APIs, or cron jobs that lack user interfaces.
- Running internal unit tests that do not involve DOM rendering or browser-based UI.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Accessibility is a nice-to-have we can add later." | Retrofitting accessibility is extremely expensive as it requires changing DOM structures and component behaviors. Day-one accessibility ensures robust interfaces. |
| "A styled div with an onClick handler is good enough." | Styled divs lack default keyboard interactivity (Tab focus, Enter/Space activation) and screen reader support, completely blocking disabled users. |
| "Default browser focus outlines look ugly, so I'll disable them." | Disabling focus outlines makes the app unusable for keyboard-only users. Always replace default outlines with premium custom `:focus-visible` styles. |

## Red Flags

- Interactive elements constructed from `<div>` or `<span>` without ARIA roles, `tabindex="0"`, or keyboard event listeners.
- Using `outline: none` or `outline: 0` in CSS without providing a visible focus alternative.
- Icon-only buttons lacking `aria-label` or descriptive visually-hidden text.
- Form inputs without corresponding `<label>` tags or using placeholder attributes as the sole label.

## Verification

After completing the UI implementation, verify:
- [ ] Tab key navigation succeeds through all interactive elements in logical order.
- [ ] No keyboard focus traps exist (user can navigate into and out of all controls).
- [ ] Screen reader roles and accessibility trees are checked (using Chrome DevTools or axe audits).
- [ ] All inputs have associated labels and announce error states correctly using ARIA attributes.
- [ ] Interactive modals restrict focus to their active contents and restore focus on exit.
