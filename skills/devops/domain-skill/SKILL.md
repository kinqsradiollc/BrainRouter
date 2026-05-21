---
name: domain-skill
description: Architect production-ready domain routing. Configure reverse proxies (e.g., Traefik), SSL/TLS certificates, and Cloudflare tunnels for secure public access.
hints: |
  - Always identify the primary hostnames (e.g. app.domain.com, api.domain.com) before structuring routing.
  - Review Traefik labels in docker-compose.yml to ensure correct entrypoint and rule mappings.
  - Use Cloudflare Zero Trust tunnels to establish secure outbound-only ingress paths without exposing local ports.
  - Set up environment variables (like DOMAIN, CORS_ORIGIN, and WebAuthn relying party IDs) dynamically.
  - Test routing and certificate issuance sequentially, beginning with Flexible TLS before strict enforcement.
---

# Custom Domain & Networking

## Overview

A robust routing architecture ensures secure, encrypted public access to backend and frontend services. This skill guides the setup of production-ready routing using reverse proxies (e.g., Traefik v3) coupled with secure edge ingress (e.g., Cloudflare Tunnels) to direct external traffic cleanly to containerized services without exposing local ports.

## Ingress Architecture

```
Browser
  │  HTTPS (TLS terminated by Cloudflare)
  ▼
Cloudflare Edge (api.yourdomain.com)
  │  Outbound tunnel (no open ports needed)
  ▼
cloudflared daemon  ← Docker container, profile: production
  │  HTTP  http://traefik:80
  ▼
Traefik v3          ← traefik container
  │  HTTP  :3001
  ▼
Node.js / Express   ← backend container
```

> Local dev skips cloudflared entirely. Traefik routes `Host(\`localhost\`)` directly.

---

## Environment Variables

Ensure the following networking environment variables are configured in the `.env` or deployment settings:

| Variable | Dev value | Prod value | Purpose |
|---|---|---|---|
| `DOMAIN` | `api.yourdomain.com` | `api.yourdomain.com` | Traefik HTTPS router host rule |
| `ACME_EMAIL` | `admin@yourdomain.com` | `admin@yourdomain.com` | Let's Encrypt certificate contact |
| `CLOUDFLARE_TUNNEL_TOKEN` | *(blank)* | `<token from CF dashboard>` | Authenticates cloudflared to Cloudflare |
| `FRONTEND_URL` | `http://localhost:3000` | `https://yourdomain.com` | Email link base URL |
| `CORS_ORIGIN` | `http://localhost:3000,https://yourdomain.com` | `https://yourdomain.com` | Allowed CORS origins |
| `PASSKEY_RP_ID` | `localhost` | `yourdomain.com` | WebAuthn Relying Party ID |
| `PASSKEY_ORIGIN` | `http://localhost:3000` | `https://yourdomain.com` | WebAuthn allowed origin |

---

## Traefik Router Setup

Two routers are typically configured in `docker-compose.yml` on the `backend` service:

### HTTP Router (always active)

```yaml
- "traefik.http.routers.backend.rule=Host(`localhost`) || Host(`api.yourdomain.com`)"
- "traefik.http.routers.backend.entrypoints=web"
```

Accepts both `localhost` (dev) and `api.yourdomain.com` (prod via cloudflared HTTP passthrough).

### HTTPS Router (activates with Cloudflare Full strict)

```yaml
- "traefik.http.routers.backend-secure.rule=Host(`api.yourdomain.com`)"
- "traefik.http.routers.backend-secure.entrypoints=websecure"
- "traefik.http.routers.backend-secure.tls=true"
- "traefik.http.routers.backend-secure.tls.certresolver=letsencrypt"
```

Traefik will auto-issue a Let's Encrypt cert once `api.yourdomain.com` is publicly resolvable.

---

## Cloudflare SSL Mode Decision

| Mode | When to use | Traefik TLS needed? |
|---|---|---|
| **Flexible** | Dev/staging; simplest setup | ❌ No |
| **Full** | Traefik has any cert (even self-signed) | ✅ Yes |
| **Full (strict)** | Production; Traefik has valid Let's Encrypt cert | ✅ Yes |

> **Recommended:** Start with **Flexible** to verify connectivity, then switch to **Full (strict)** once the domain is proven reachable and Let's Encrypt issues the cert.

---

## Workflow

### Step 1 — Create the tunnel

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Networks → Tunnels → Create a tunnel**
2. Choose **Cloudflared** connector
3. Name the tunnel `app-tunnel`
4. Copy the **tunnel token** — this is your `CLOUDFLARE_TUNNEL_TOKEN`

### Step 2 — Configure Public Hostname

In the tunnel settings, add a Public Hostname:

| Field | Value |
|---|---|
| Subdomain | `api` |
| Domain | `yourdomain.com` |
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
docker logs cloudflared --tail 20
# Expected: "Connection established" / "Registered tunnel connection"
```

### Step 5 — Verify

```bash
# Health check through the full tunnel
curl https://api.yourdomain.com/health
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
| Tunnel connected but 502 | cloudflared can't reach `traefik:80` | Verify both are on the same docker network; check `docker network inspect` |
| Let's Encrypt cert not issued | Domain not publicly reachable on port 80 | Use Flexible SSL mode until tunnel is confirmed working |
| CORS errors in browser | `CORS_ORIGIN` missing origin domain | Add proper origin to `.env` and restart backend |
| WebAuthn fails on prod | `PASSKEY_RP_ID` still set to `localhost` | Update to the production domain and redeploy |
| `--profile production` not recognized | Old Docker Compose version | Upgrade to Docker Compose v2.x (`docker compose version`) |

## When to Use

- Mapping custom domains (e.g., `app.domain.com` or `api.domain.com`) to containerized services.
- Designing secure ingress architectures via reverse proxies (e.g., Traefik, Nginx) and edge providers (e.g., Cloudflare).
- Setting up SSL/TLS termination, automated certificate resolvers (Let's Encrypt), or Cloudflare Tunnels (`cloudflared`).

**When NOT to use:**
- Basic local-only dev environments that do not require DNS mapping or secure public access.
- Deploying on serverless platforms (e.g., Vercel, Netlify) where domain routing is fully managed by the provider.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I will expose the container port directly to the internet." | Exposing service ports directly bypasses reverse proxy benefits (load balancing, SSL termination, request filtering) and introduces massive security vulnerabilities. |
| "I'll use HTTP in staging to save setup time." | Staging must mimic production. Omitting TLS in staging leads to hidden CORS, WebAuthn, cookie security, or certificate routing errors that only show up in production. |
| "Setting up Cloudflare tunnels is too slow; I'll just open port 80/443." | Opening incoming ports makes the host machine an active target for automated port scanners. Outbound-only tunnels are vastly more secure. |

## Red Flags

- Hardcoded domain names in docker-compose configurations instead of environment variables.
- Using Flexible SSL/TLS modes in production indefinitely without terminating TLS at the reverse proxy (leaves edge-to-origin traffic unencrypted).
- Mixing production tunnel credentials or domain records directly inside shared development files.
- Exposing Traefik dashboards publicly without authentication or strong basic auth middlewares.

## Verification

After completing the domain setup, verify:
- [ ] Ingress paths are tested and return valid HTTP statuses (e.g., 200 OK, secure 301 redirects).
- [ ] SSL/TLS certificate is verified as valid and issued by a recognized CA (e.g., Let's Encrypt, Cloudflare Edge).
- [ ] CORS origins and authentication parameters (e.g., WebAuthn/Passkey RP IDs) match the active host exactly.
- [ ] Cloudflared connections are confirmed in container logs with `Connection established` and no active errors.
