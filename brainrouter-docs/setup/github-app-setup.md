# Setting up the BrainRouter GitHub App (org repo linking)

This connects a Team/org's repositories to the BrainRouter memory system through a
GitHub App. A GitHub App gives BrainRouter **short-lived, per-installation tokens**
scoped to only the repos you grant — no broad personal access token.

> **Two boundaries you handle yourself:** authenticating to GitHub (passkey / 2FA)
> and the **private key** (`.pem`). Never paste the private key anywhere but the
> encrypted dashboard field below.

Example org used throughout: **`kinqsradiollc`**. Substitute your own.

---

## 1. Create the GitHub App

1. Go to **`https://github.com/organizations/kinqsradiollc/settings/apps/new`**
   (org-owned App). Authenticate with your passkey when GitHub asks (sudo mode).
2. Fill in:
   - **GitHub App name:** `BrainRouter Memory (kinqsradiollc)` — must be globally unique.
   - **Homepage URL:** `http://localhost:3000` (or your dashboard URL).
   - **Webhook:**
     - **Repo-linking only (recommended to start):** UNCHECK **Active**. GitHub
       cannot reach `localhost`, and linking repos to memory does NOT need webhooks.
     - **Triggers later (@mention automation):** check **Active**; set **Webhook URL**
       to `https://<your-public-tunnel>/api/triggers/github/events` and generate a
       strong **Webhook secret** (save it — you enter it in the dashboard).
3. **Repository permissions** (the minimum for memory):
   - **Contents** → **Read-only** (read code/docs to index into memory).
   - **Metadata** → **Read-only** (mandatory; auto-selected).
   - *For triggers later:* **Issues** → Read & write, **Pull requests** → Read & write.
4. **Subscribe to events** (only if the webhook is Active): **Issues**,
   **Issue comment**, **Pull request**.
5. **Where can this GitHub App be installed?** → **Only on this account**.
6. Click **Create GitHub App**.

## 2. Grab the credentials

On the App's settings page after creation:
- **App ID** — shown near the top (a number).
- **Private key** — click **Generate a private key**; a `.pem` downloads. Keep it safe.
- **Webhook secret** — only if you set one in step 1.

## 3. Install the App (grant repo access)

1. Left sidebar → **Install App** → **Install** next to `kinqsradiollc`.
2. Choose **Only select repositories** → tick **`kinqsradiollc/BrainRouter`**
   (and any other repos you want in memory) → **Install**.
3. **Installation ID:** after installing, the browser URL is
   `.../settings/installations/<INSTALLATION_ID>` — copy that number.

## 4. Configure it in the dashboard — `http://localhost:3000/integrations`

Prerequisite: the backend must have **`BRAINROUTER_SECRET_KEY`** set (the private key
is sealed with it at rest).

On **Integrations**, fill the GitHub App form:
| Field | Value |
|---|---|
| **App ID** | the number from step 2 |
| **Installation ID** | the number from step 3 |
| **API base** | leave blank → defaults to `https://api.github.com` (set only for GitHub Enterprise) |
| **Private key** | paste the **entire** `.pem` contents, incl. `-----BEGIN/END RSA PRIVATE KEY-----` |
| **Webhook secret** | the secret from step 1 (blank if no webhook) |

Save. Keys are write-only — they're never shown again.

## 5. Link repositories to memory

**Integrations → GitHub → Manage repositories** (`/integrations/github`):
- **Connection** shows "✓ Connected as `kinqsradiollc`".
- **+ Add repository** → search the repos the App can access → **Link**.
- To grant more repos later, use **Configure repos on GitHub ↗**.

A linked repo is stored as a Project carrying the repo URL; the memory system tracks it.

---

## Notes & troubleshooting

- **localhost + webhooks:** GitHub can't POST to `localhost`. Repo-linking works
  without webhooks (it uses the installation token to read repos). Only @mention
  **triggers** need a public webhook URL — front the backend with a Cloudflare
  tunnel / ngrok and set the webhook URL + secret then.
- **"No repositories" after connecting:** the App is installed but no repos were
  granted — use **Configure repos on GitHub** and add them.
- **Wrong org / user-owned App:** to create a *personal* App instead, use
  `https://github.com/settings/apps/new`; installation + IDs work the same way.
- The webhook endpoint BrainRouter listens on is `POST /api/triggers/github/events`.
