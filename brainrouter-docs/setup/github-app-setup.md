# Setting up the BrainRouter GitHub App

BrainRouter integrates with GitHub through **one** GitHub App — "**BrainRouter Agent**"
in the reference deployment. That single App backs three capabilities:

| Capability | Auth mechanism | Used by |
|---|---|---|
| **Connect GitHub** (per user) | **device flow** → short-lived *user* token, sealed server-side | Track sync, connectors, repo pickers |
| **Repo linking → memory** | **installation** token (App ID + private key) | Indexing linked repos into the memory engine |
| **PR-review bot** | **installation** token + **check-runs** | Automatic security + code review on pull requests (ADR-017 D5) |

A GitHub App is the right primitive because it issues **short-lived, per-installation
tokens** scoped only to the repos you grant — no broad personal access token sitting
on anyone's machine.

> **Two boundaries you handle yourself:** authenticating to GitHub (passkey / 2FA)
> and the **private key** (`.pem`). Never paste the private key anywhere but the
> encrypted dashboard field described below.

Example org used throughout: **`kinqsradiollc`**. Substitute your own.

---

## 1. Create the GitHub App

1. Go to **`https://github.com/organizations/kinqsradiollc/settings/apps/new`**
   (org-owned App). Authenticate with your passkey when GitHub asks (sudo mode).
2. **Identity:**
   - **GitHub App name:** e.g. `BrainRouter Agent` — must be globally unique. This
     becomes the bot login (`brainrouter-agent[bot]`) and the App **slug**
     (`brainrouter-agent`). Renaming later is safe (App ID, key, webhook, and
     check-run names are unchanged), but the bot's `[bot]` login follows the name.
   - **Homepage URL:** `http://localhost:3000` (or your dashboard URL).
3. **Enable Device Flow** ✅ — under *Identifying and authorizing users*, check
   **Enable Device Flow**. This is what powers per-user **Connect GitHub** without a
   client secret.
4. **⚠️ Do NOT enable "Expire user authorization tokens".** The device flow is a
   *public-client* flow (no client secret), so an expired user token **cannot be
   refreshed** — leaving it on would force every user to reconnect every ~8 hours and
   would silently break Track sync and repo pickers. Leave it **unchecked** so user
   tokens are long-lived. (See ADR-016 C2.)
5. **Webhook:**
   - **Getting started (repo-linking + device flow only):** UNCHECK **Active**.
     GitHub cannot reach `localhost`, and neither device flow nor repo-linking needs
     inbound webhooks.
   - **PR-review bot / @mention triggers:** check **Active**; set **Webhook URL** to
     `https://<your-public-host>/api/triggers/github/events` and generate a strong
     **Webhook secret** (save it — you enter it in the dashboard).
6. **Repository permissions:**
   | Permission | Access | Why |
   |---|---|---|
   | **Metadata** | Read-only | Mandatory (auto-selected). |
   | **Contents** | Read-only | Read code/docs to index into memory + fetch PR diffs. |
   | **Pull requests** | Read & write | Post review comments, inline `suggestion`s, grouped reviews. |
   | **Issues** | Read & write | Track sync (issues) + @mention triggers. |
   | **Checks** | Read & write | Post the gating **check-runs** the PR-review bot relies on. |
7. **Subscribe to events** (only if the webhook is Active): **Pull request**,
   **Issue comment** (drives the `/review` re-run), **Issues**, **Push**.
8. **Where can this GitHub App be installed?** → **Only on this account**.
9. Click **Create GitHub App**.

## 2. Grab the credentials

On the App's settings page after creation:
- **App ID** — a number near the top (e.g. `4237068`). Powers installation tokens.
- **Client ID** — e.g. `Iv23li…`. Powers the **device flow** (Connect GitHub).
- **App slug** — the last path segment of the App's settings URL,
  `github.com/organizations/<org>/settings/apps/<app-slug>` (e.g. `brainrouter-agent`).
  Powers the one-click Install / Configure links.
- **Private key** — click **Generate a private key**; a `.pem` downloads. Keep it safe.
- **Webhook secret** — only if you set one in step 1.

## 3. Install the App (grant repo access)

1. Left sidebar → **Install App** → **Install** next to `kinqsradiollc`.
2. Choose **Only select repositories** → tick **`kinqsradiollc/BrainRouter`** (and any
   other repos you want indexed / reviewed) → **Install**.
3. **Installation ID:** after installing, the browser URL is
   `.../settings/installations/<INSTALLATION_ID>` — copy that number.
4. **Accept new permission requests when they appear.** If you add a permission later
   (e.g. **Checks: write** for the review bot), GitHub shows the installation a "review
   request" banner — you must **accept** it for the new scope to take effect. A bot
   review that logs `unknown-installation` or check-runs that never post usually means
   an unaccepted permission or a blank Installation ID.

## 4. Configure it in the dashboard — `/integrations`

Prerequisite: the backend must have **`BRAINROUTER_SECRET_KEY`** set (the private key
and user tokens are sealed with it at rest).

On **Integrations**, fill the GitHub App form:

| Field | Value |
|---|---|
| **App ID** | the number from step 2 |
| **Client ID** | from step 2 — enables device-flow **Connect GitHub** |
| **App slug** | from step 2 — enables the one-click **Install / Configure repos** buttons |
| **Installation ID** | the number from step 3 — **needed to list/link repos and to run the PR-review bot** (each mints a token per installation) |
| **API base** | leave blank → defaults to `https://api.github.com` (set only for GitHub Enterprise) |
| **Private key** | paste the **entire** `.pem` contents, incl. `-----BEGIN/END … PRIVATE KEY-----` |
| **Webhook secret** | the secret from step 1 (blank if no webhook) |

Save. Secrets are **write-only** — they're never shown again.

## 5. Per-user Connect GitHub (device flow)

Each user connects their own GitHub identity once — no PAT on their machine:

- **Desktop:** **Settings → Connectors → GitHub → Connect**. A short **user code** +
  `github.com/login/device` link appears; enter the code, approve, done.
- **CLI:** `brainrouter github login` (device flow), `brainrouter github status`,
  `brainrouter github logout`.
- **Dashboard:** **Integrations → GitHub → Connect**.

The resulting user token is sealed server-side and used for that user's repo lists and
**Track sync** (below). Because the App has token-expiry **off** (step 1.4), this
connection is long-lived.

## 6. Link repositories to memory

**Integrations → GitHub → Manage repositories** (`/integrations/github`):
- **Connection** shows "✓ Connected as `kinqsradiollc`".
- **+ Add repository** → search the repos the App can access → **Link**.
- To grant more repos later, use **Configure repos on GitHub ↗**.

A linked repo is stored as a Project carrying the repo URL; the memory system tracks it.

## 7. Track sync over GitHub (OAuth, no PAT)

Track (the built-in PM board) syncs issues to/from GitHub through the **sealed user
token** — the token never touches the desktop:

- Requirements: signed in to BrainRouter (**Settings → Account**) **and** GitHub
  connected (step 5). The repo is auto-detected from the workspace's `git remote`.
- The desktop tunnels Track's GitHub REST calls through the backend
  `POST /api/connectors/github/track/proxy` — a **constrained** proxy (only
  `/repos/{owner}/{repo}/(issues|issues/N|issues/N/comments|collaborators)`, host pinned
  to `api.github.com`), so it can't be turned into an open/SSRF proxy.
- If no BrainRouter account or GitHub connection is present, Track falls back to a
  local `GITHUB_TOKEN` / gh PAT.

## 8. PR-review bot (security + code review)

Once the webhook is Active (step 1.5) and **Checks: write** is accepted (step 3.4),
every pull request on a **reviewed** repo gets two automatic passes:

- **🛡️ Security review — gating.** Vulnerability findings (injection, SSRF, auth,
  secrets, …), CWE-tagged, with inline ```suggestion``` fixes. A critical/high finding
  fails the **`BrainRouter security review`** check-run so branch protection can hold the
  merge.
- **🔎 Code review — advisory.** Correctness, clarity, architecture, performance, test
  coverage. Posts suggestions but **never fails** a check-run (it's guidance, not a gate).

**Which repos get reviewed:** only repos linked for review in the dashboard
(**Reviews** page → *Auto-review repositories*). Un-listed repos are skipped.

**Per-repo policies** (dashboard → **Reviews**), each independent:
- **Approve when clean** — post an `APPROVE` review when a lens finds nothing.
- **Block on findings** — a blocking finding fails the check-run (default **on**).
- **Re-review on push** — re-run both lenses on every new commit (default **on**).

**Re-run a review** any time by commenting **`/review`** on the PR.

**Manage from the desktop:** **Settings → PR Reviews** lists the PRs the bot has
reviewed (lens, findings, blocking count, status) and links straight to each PR.

## 9. Branch protection (make the gate real)

To make the security review actually hold a merge, require the checks on the base
branch. Reference setup for `release/0.4.17`:

Required status checks:
- `Build & Test (Node 22.x)`
- `Lint & Typecheck`
- `Security Audit (deps)`
- `BrainRouter security review`  ← the bot's gating check

The **code-review** check is intentionally **not** required (advisory). Set
`enforce_admins: false` if you want owners to retain a manual override.

```bash
gh api -X PUT repos/<org>/<repo>/branches/<branch>/protection/required_status_checks \
  -f strict=true \
  -f 'checks[][context]=Build & Test (Node 22.x)' \
  -f 'checks[][context]=Lint & Typecheck' \
  -f 'checks[][context]=Security Audit (deps)' \
  -f 'checks[][context]=BrainRouter security review'
```

---

## Notes & troubleshooting

- **Token expiry / "reconnect" loops:** if Connect GitHub keeps dropping, verify
  **"Expire user authorization tokens" is OFF** on the App (step 1.4). A secret-less
  device flow cannot refresh an expired token.
- **`unknown-installation` / no check-runs:** the Installation ID is blank in the
  dashboard, or a permission (e.g. Checks: write) is pending — accept the installation's
  review request (step 3.4).
- **Security review never posts on a big PR:** the review is a background job; a
  transient provider overload is retried with jittered backoff + a larger budget, then a
  `/review` comment re-runs it. If it *fails* (blocking findings), that's the gate doing
  its job — fix the findings and push.
- **localhost + webhooks:** GitHub can't POST to `localhost`. Device flow and
  repo-linking work without webhooks; only the PR-review bot and @mention triggers need a
  public webhook URL — front the backend with a Cloudflare tunnel / ngrok.
- **Wrong org / user-owned App:** to create a *personal* App, use
  `https://github.com/settings/apps/new`; installation + IDs work the same way.
- The webhook endpoint BrainRouter listens on is `POST /api/triggers/github/events`.

See also: **ADR-016** (server-side connectors / device-flow broker), **ADR-017**
(production flows + PR-security bot).
