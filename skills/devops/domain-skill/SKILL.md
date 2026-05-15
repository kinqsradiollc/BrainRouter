---
name: domain-infrastructure-routing
description: Architect production-ready domain routing. Configure Traefik ingress, SSL/TLS certificates, and Cloudflare tunnels for secure public access.
---

# Custom Domain & Networking

Connect `api.[PROJECT_DOMAIN]` (Cloudflare-managed) to the [PROJECT_NAME] Node.js backend running in Docker via Traefik.

## Architecture

```
Browser
  │  HTTPS (TLS terminated by Cloudflare)
  ▼
Cloudflare Edge (api.[PROJECT_DOMAIN])
  │  Outbound tunnel (no open ports needed)
  ▼
cloudflared daemon  ← Docker container, profile: production
  │  HTTP  http://traefik:80
  ▼
Traefik v3          ← [PROJECT_NAME]-traefik container
  │  HTTP  :3001
  ▼
Node.js / Express   ← [PROJECT_NAME]-backend container
```

> Local dev skips cloudflared entirely. Traefik routes `Host(\`localhost\`)` directly.

---

## Environment Variables

| Variable | Dev value | Prod value | Purpose |
|---|---|---|---|
| `DOMAIN` | `api.[PROJECT_DOMAIN]` | `api.[PROJECT_DOMAIN]` | Traefik HTTPS router host rule |
| `ACME_EMAIL` | `admin@[PROJECT_DOMAIN]` | same | Let's Encrypt certificate contact |
| `CLOUDFLARE_TUNNEL_TOKEN` | *(blank)* | `<token from CF dashboard>` | Authenticates cloudflared to Cloudflare |
| `FRONTEND_URL` | `http://localhost:3000` | `https://[PROJECT_DOMAIN]` | Email link base URL |
| `CORS_ORIGIN` | `http://localhost:3000,https://[PROJECT_DOMAIN]` | `https://[PROJECT_DOMAIN]` | Allowed CORS origins |
| `PASSKEY_RP_ID` | `localhost` | `[PROJECT_DOMAIN]` | WebAuthn Relying Party ID |
| `PASSKEY_ORIGIN` | `http://localhost:3000` | `https://[PROJECT_DOMAIN]` | WebAuthn allowed origin |

---

## Traefik Router Setup

Two routers exist in `docker-compose.yml` on the `backend` service:

### HTTP Router (always active)

```yaml
- "traefik.http.routers.backend.rule=Host(`localhost`) || Host(`api.[PROJECT_DOMAIN]`)"
- "traefik.http.routers.backend.entrypoints=web"
```

Accepts both `localhost` (dev) and `api.[PROJECT_DOMAIN]` (prod via cloudflared HTTP passthrough).

### HTTPS Router (activates with Cloudflare Full strict)

```yaml
- "traefik.http.routers.backend-secure.rule=Host(`api.[PROJECT_DOMAIN]`)"
- "traefik.http.routers.backend-secure.entrypoints=websecure"
- "traefik.http.routers.backend-secure.tls=true"
- "traefik.http.routers.backend-secure.tls.certresolver=letsencrypt"
```

Traefik will auto-issue a Let's Encrypt cert once `api.[PROJECT_DOMAIN]` is publicly resolvable.

---

## Cloudflare SSL Mode Decision

| Mode | When to use | Traefik TLS needed? |
|---|---|---|
| **Flexible** | Dev/staging; simplest setup | ❌ No |
| **Full** | Traefik has any cert (even self-signed) | ✅ Yes |
| **Full (strict)** | Production; Traefik has valid Let's Encrypt cert | ✅ Yes |

> **Recommended:** Start with **Flexible** to verify connectivity, then switch to **Full (strict)** once the domain is proven reachable and Let's Encrypt issues the cert.

---

## Procedure: Activating Cloudflare Tunnel

### Step 1 — Create the tunnel

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Networks → Tunnels → Create a tunnel**
2. Choose **Cloudflared** connector
3. Name the tunnel `[PROJECT_NAME]-tunnel`
4. Copy the **tunnel token** — this is your `CLOUDFLARE_TUNNEL_TOKEN`

### Step 2 — Configure Public Hostname

In the tunnel settings, add a Public Hostname:

| Field | Value |
|---|---|
| Subdomain | `api` |
| Domain | `[PROJECT_DOMAIN]` |
| Service Type | `HTTP` |
| Service URL | `traefik:80` |

Cloudflare will automatically create the DNS record:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `api` | `<tunnel-id>.cfargotunnel.com` | ✅ Proxied |

### Step 3 — Add token to `.env`

```bash
# .env
CLOUDFLARE_TUNNEL_TOKEN=<paste token here>
```

### Step 4 — Start cloudflared

```bash
# Only starts services with the production profile
docker compose --profile production up -d cloudflared

# Verify connection
docker logs [PROJECT_NAME]-cloudflared --tail 20
# Expected: "Connection established" / "Registered tunnel connection"
```

### Step 5 — Verify

```bash
# Health check through the full tunnel
curl https://api.[PROJECT_DOMAIN]/health
# Expected: { "status": "ok", ... }

# Check Traefik picked up the new router
open http://localhost:8080   # Traefik dashboard
```

---

## SSL Mode: Switch to Full (strict)

Once Let's Encrypt issues the cert (check Traefik dashboard → TLS), switch Cloudflare:

1. Cloudflare dashboard → **SSL/TLS → Overview**
2. Change mode to **Full (strict)**
3. No Docker restart needed — Traefik handles this automatically

---

## Cloudflared Compose Profile

The `cloudflared` service uses `profiles: [production]` so it **never starts** during normal dev:

```bash
# Dev (cloudflared excluded)
docker compose up -d

# Production (all services including cloudflared)
docker compose --profile production up -d

# Start cloudflared only (if stack is already running)
docker compose --profile production up -d cloudflared
```

---

## Migration Path: Tunnel → VPS + WireGuard

When you move to a dedicated server with a static IP:

1. **Remove** `cloudflared` service from docker-compose (or keep as fallback)
2. **Point** Cloudflare DNS `A` record `api` → `<vps-ip>` (Proxied ✅)
3. **Open** ports `80` and `443` on the VPS firewall
4. **Traefik** will handle Let's Encrypt directly via HTTP challenge on port 80
5. **Update** SSL/TLS mode to **Full (strict)** in Cloudflare

The Traefik labels and ACME config in docker-compose remain identical — only the ingress path changes.

---

## Pitfalls

| Problem | Cause | Fix |
|---|---|---|
| `curl: (6) Could not resolve host` | DNS not propagated | Wait 1–5 min after Cloudflare saves the CNAME |
| Tunnel connected but 502 | cloudflared can't reach `traefik:80` | Verify both are on `[PROJECT_NAME]-network`; check `docker network inspect` |
| Let's Encrypt cert not issued | Domain not publicly reachable on port 80 | Use Flexible SSL mode until tunnel is confirmed working |
| CORS errors in browser | `CORS_ORIGIN` missing `https://[PROJECT_DOMAIN]` | Add to `.env` and restart backend |
| WebAuthn fails on prod | `PASSKEY_RP_ID` still set to `localhost` | Update to `[PROJECT_DOMAIN]` and redeploy |
| `--profile production` not recognized | Old Docker Compose version | Upgrade to Docker Compose v2.x (`docker compose version`) |
