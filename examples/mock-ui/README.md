# Mock UI — a target for the Browser panel

A tiny vanilla-TypeScript app (Vite) with three pages and a handful of simple
functions, every interactive element carrying a `data-testid`. Use it to exercise
the desktop **Browser** panel: render it, **Extract** the on-screen testids, then
drive them (tap / type / assertVisible), record a flow, etc.

## Run it

From this folder:

```bash
npm install      # one-time (or rely on the monorepo's hoisted vite)
npm run dev      # serves http://localhost:5174
```

It serves on **http://localhost:5174** — the URL the Browser panel loads by
default. Open the desktop app's **Browser** panel and it should appear.

## What's in it

- **Home** (`#/home`) — a counter: `counter-increment`, `counter-value`, `counter-reset`.
- **Login** (`#/login`) — `email-field`, `password-field`, `login-submit`, `login-message`
  (try a bad email → error; `you@example.com` + a 6+ char password → success).
- **Todos** (`#/todos`) — `todo-input`, `todo-add`, `todo-list`, `todo-item`, `todo-remove`, `todo-count`.
- **Nav** — `main-nav`, `nav-home`, `nav-login`, `nav-todos`.

## Try this in the Browser panel

1. Set the URL to `http://localhost:5174` (it's the default).
2. **Extract** → the rail lists every `data-testid` on the current screen.
3. **Highlight** → see them outlined in the page.
4. On the element list, click **Run** on `counter-increment` a few times — watch `counter-value` change.
5. Navigate to Login (tap `nav-login`), **type** into `email-field` / `password-field`, **tap** `login-submit`.
6. Toggle **Record**, run a few actions, then **Save** the flow and **Run** it back.

## Files

- `src/pages.ts` — the UI (HTML per screen, with `data-testid`s).
- `src/functions.ts` — the logic (`validateEmail`, `login`, `addTodo`, `Counter`, …).
- `src/main.ts` — a hash router that mounts pages and wires events to the functions.
