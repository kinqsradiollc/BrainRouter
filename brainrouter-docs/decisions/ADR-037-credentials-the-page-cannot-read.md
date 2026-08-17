# ADR-037 — Credentials the page cannot read

**Status:** Accepted — implemented (2026-08-17, shipped to `release/0.4.21`). The credential-hardening program is complete across 8 slices. Backend: **B1** revocable refresh-session store (migration 065; the ADR's "already-merged" mitigation was in fact dead code — a 30-day un-revocable token); **B2** boot-refusal of `*`+credentials on API + gateway ports (D3); **B3** `br_refresh` httpOnly cookie + `csrfOriginGuard` + double-submit CSRF (D1/D2). Dashboard: **D-1** identity from `/api/auth/me`; **D-2** cookie transport + in-memory access token + D5 forced-signout, with the CSRF token as a **readable `br_csrf` double-submit cookie** so it bootstraps after a page reload; **D-3** the API key (and jwt/refresh) out of `localStorage` into memory (D4, shown once) + the auth gate moved onto the resolved cookie session; **B4** the cookie-path `/refresh` returns no refresh token in the body (an XSS cannot read a token never sent to script), while the SDK's body-token path still rotates for backward compatibility. Net: the dashboard persists NO credential to storage — an XSS can use the in-memory access token while it runs but cannot take a durable credential away. NOTE: §5's acceptance test ("run script in the page, try to read the session; then use what you got from another machine after signing out") is a live-stack check for the owner to run; the desktop/CLI (bearer + config.json, different threat model) are unchanged.
**Depends on:** ADR-028 (surfaces that tell the truth), ADR-017 (production program), and the
session work merged in `feat(auth): revocable sessions, refresh-token theft detection`.

---

## 1. Where we are

`brainrouter-dashboard/lib/client-auth.ts` keeps three credentials in `localStorage`:

```ts
const JWT_KEY = "brainrouter_jwt";          // access token
const REFRESH_KEY = "brainrouter_refresh";  // refresh token
const API_KEY = "brainrouter_api_key";      // API key
```

Any script that runs on the page reads all three. A single XSS — in our code, in a dependency, in an
injected analytics tag — hands an attacker the whole set.

The file explains itself honestly: *"ALWAYS localStorage so the session is shared across tabs and
survives a browser restart."* Both are real requirements. Neither requires `localStorage`.

### 1.1 What each one costs when read

- **The access token** expires in about an hour. Least bad, and still a live session.
- **The refresh token** mints new access tokens. It is now revocable and its reuse is detected — that
  is the mitigation already merged — but revocation only helps once somebody *notices*. Until then
  it is a working session.
- **The API key does not expire at all.** It is the worst of the three by a distance: it survives a
  password change, survives a signout, survives revoking every session, and nothing in the product
  tells its owner it was taken.

### 1.2 The thing that shapes the whole design

**The dashboard is cross-origin with the API.** `BASE_URL` is
`process.env.NEXT_PUBLIC_API_URL || "http://localhost:3747"`, while the dashboard serves from its own
origin (`http://localhost:3000` in the dev allowlist).

That single fact removes the easy version of this change:

- A same-origin app can set `SameSite=Strict` cookies and get CSRF protection for free.
- A cross-origin app needs `SameSite=None; Secure`, and **`SameSite=None` provides no CSRF
  protection at all**. Every state-changing request must be defended explicitly.

So "move it to a cookie" is not the change. **"Move it to a cookie AND add CSRF"** is the change, and
doing the first without the second would trade a vulnerability that needs XSS for one that needs only
a link.

The CORS layer is already prepared for credentialed requests: `corsMiddleware` reflects an allowed
origin and sets `Access-Control-Allow-Credentials: true` (`securityHeaders.ts:71-72`).

---

## 2. Decisions

### D1 · The refresh token becomes an httpOnly cookie; the access token lives in memory

- **Refresh token** — `HttpOnly; Secure; SameSite=None; Path=/api/auth`. Page script cannot read it,
  and it is only sent to the endpoints that need it.
- **Access token** — held in a module variable, never persisted. An XSS can still use the page's
  session while it runs, but it cannot take a credential away with it.
- **On load**, the app calls `/api/auth/refresh` with the cookie and gets an access token in memory.

This preserves both requirements the current comment names: the session survives a browser restart
(the cookie does), and it is shared across tabs (each tab refreshes from the same cookie).

> The prize is not "no token in the browser". It is that **what an XSS steals expires in an hour and
> cannot renew itself.**

### D2 · CSRF protection is part of this change, not a follow-up

With `SameSite=None`, the browser attaches the cookie to requests from any site. Two defences, both
cheap, and we should have both:

1. **Origin/Referer check on every state-changing request.** The API already computes an allowlist;
   `POST`/`PUT`/`PATCH`/`DELETE` with a missing or non-allowlisted `Origin` is refused.
2. **A double-submit token** for `/api/auth/refresh` specifically — a non-httpOnly, non-sensitive
   value the page reads and echoes in a header, which a cross-site attacker cannot read.

An attacker who can only *make* requests has neither the header nor an allowed origin.

### D3 · `*` must never combine with credentials

`isOriginAllowed` returns true when the allowlist contains `*` (`securityHeaders.ts:53`), and the
caller then sets `Access-Control-Allow-Credentials: true`. Today `BRAINROUTER_CORS_ORIGIN` is
`http://localhost:3000`, so this is latent — but once the session is a cookie, an operator who sets
`*` is handing every site on the internet an authenticated session.

**Refuse the combination at config load**, loudly, rather than serving it. A wildcard origin is
compatible with anonymous APIs and with nothing else.

### D4 · The API key leaves the browser

The API key is for programmatic callers. It should be **shown once at creation** and never persisted
by the dashboard; the dashboard authenticates with its session like any other client. If a screen
genuinely needs to act as the key, it asks the server to act on its behalf.

This is the single biggest reduction in blast radius here, because it is the one credential that
outlives every remedy we have.

### D5 · Migration is a signout, and it says so

Existing sessions hold tokens the new flow will not read. On first load after the upgrade, any
`localStorage` credential is **deleted** — not migrated into a cookie, because a token that has been
readable by script for months should not be promoted to a long-lived cookie — and the user signs in
once.

Deleting them is also the only way the old values stop being an XSS target on returning devices.

### D6 · Dev must keep working, and must not do so by weakening production

`Secure` cookies are permitted on `http://localhost` by current browsers, so the loopback development
flow works unchanged. Where a non-localhost HTTP origin is used, the correct answer is a TLS dev
proxy — **not** dropping `Secure`, and not a code path that disables it, because a flag that weakens
cookies in development is a flag that will eventually be set in production.

---

## 3. What this does not do

- **It does not change the CLI or desktop.** They hold credentials in `config.json`, now `0600`, and
  in Electron `safeStorage`. Different threat model, already addressed.
- **It does not add SSO or device-bound sessions.** Both are reasonable later; neither is required to
  stop a credential being readable by page script.

---

## 4. Open questions

1. **Cookie domain.** Cross-origin between dashboard and API today. If they are ever brought under
   one registrable domain, `SameSite=Lax` becomes possible and D2's second defence gets cheaper —
   worth knowing whether that is the intended deployment shape before building.
2. **Where does the double-submit token live?** A readable cookie is standard; a value fetched into
   memory is stronger and costs a round trip on load.
3. **What replaces the API key in the UI?** Some screens may use it today as a convenience. Each one
   needs a session-authenticated route instead, and that list should be enumerated before the key is
   removed rather than discovered afterwards.
4. **Do the desktop's account calls share this flow?** The desktop talks to the same API with a
   bearer key; it should not inherit browser cookie semantics by accident.

---

## 5. How this will be judged

**One test, and it is the whole point.**

> Run script in the page — the console is enough — and try to read the session.

The refresh token must be unreachable, the API key must not be present at all, and the access token
must be the only thing obtainable and must expire within the hour. Then: **take what you got, use it
from another machine after signing out on the first.** It must fail.

Two supporting criteria:

- **A cross-site page cannot use the session.** Serve a page on another origin that POSTs to a
  state-changing endpoint with `credentials: 'include'`. It must be refused, and refused by the
  origin check rather than by luck.
- **`*` plus credentials refuses to boot.** Set `BRAINROUTER_CORS_ORIGIN=*` and the server must fail
  to start with a clear reason, not serve authenticated responses to every origin.

---

## 6. Why this is an ADR rather than a patch

Because it changes how every dashboard session authenticates, across an origin boundary, with a CSRF
surface that does not exist today — and because the failure mode of getting it half-right is worse
than the problem it fixes. Cookies without CSRF turns an XSS-only vulnerability into one reachable
from any link.

The interim mitigation is already merged: refresh tokens are revocable, their reuse revokes the
chain, and a password change ends sessions. That shrinks the blast radius of the current design from
*permanent* to *until noticed*. It does not close it, and it is not a substitute for this.
