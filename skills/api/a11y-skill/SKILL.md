---
name: a11y-skill
description: WCAG 2.1 AA accessibility mandates for the [PROJECT_NAME] frontend.
---

# Accessibility (A11Y) Skill

## Overview

[PROJECT_NAME] must meet WCAG 2.1 Level AA standards. Accessibility is a first-class citizen in our design system.

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

## Required Checks

- [ ] Page is navigable via Tab key.
- [ ] Form labels are present and correctly associated.
- [ ] Alt text is provided for all informative images.
- [ ] Modals correctly trap and restore focus.
- [ ] Contrast ratios meet WCAG AA standards.
