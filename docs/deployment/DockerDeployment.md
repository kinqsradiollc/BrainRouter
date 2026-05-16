# Deployment Guide

Instructions for deploying the project using Docker and related infrastructure.

## 🐳 Docker Setup

### Local Development
```bash
docker-compose up -d
```

### Production Build
```bash
docker build -t-api .
```

---

## 🛠️ Infrastructure Stack
- **Ingress**: Traefik / Cloudflare Tunnel.
- **SSL**: Let's Encrypt / Certbot.
- **Monitoring**: Prometheus / Grafana.

---

## 🚀 Rollout Process
1. Build images.
2. Push to registry.
3. Update `docker-compose.prod.yml` on server.
4. Restart containers.
