# WhatsApp QR Bridge — Production Hosting & Deployment Guide

This guide details how to host the persistent **Node.js Baileys WhatsApp QR Bridge Service** (`@wacrm/qr-service`) in production.

> [!IMPORTANT]
> The WhatsApp QR Bridge uses Baileys (WebSocket connection to WhatsApp Web servers) and requires a **long-lived, persistent Node.js process** with a **persistent local filesystem volume** to store AES-256-GCM encrypted WhatsApp session credentials. It **cannot** run on serverless platforms like Cloudflare Workers.

---

## 1. Hosting Architecture & Requirements

| Requirement | Minimum Specification | Recommended |
| :--- | :--- | :--- |
| **Runtime** | Node.js 20 or 22 LTS | Node.js 22-alpine Docker container |
| **CPU / RAM** | 1 vCPU, 512 MB RAM | 1 vCPU, 1 GB RAM |
| **Disk Storage** | 2 GB Persistent Volume | 5 GB Persistent Volume (stores media & sessions) |
| **Network** | Public IPv4/IPv6 with HTTPS (Port 443) | Free Let's Encrypt SSL via Caddy or Cloudflare Tunnel |
| **Process Model** | Long-running daemon with auto-restart | Docker `restart: unless-stopped` or Systemd |

---

## 2. Recommended Low-Cost Hosting Providers ($3 – $5 / month)

1. **Hetzner Cloud (CX22):** ~$3.50/mo — 2 vCPU, 4 GB RAM, 40 GB NVMe disk in Falkenstein/Nuremberg/Helsinki. High stability and bandwidth.
2. **Fly.io:** ~$3.00/mo — Deploy using `fly.toml` with a persistent 3 GB volume mounted to `/var/lib/wacrm-qr-sessions`.
3. **Railway.app:** ~$5.00/mo — Deploy Dockerfile with an attached persistent volume mounted at `/var/lib/wacrm-qr-sessions`.
4. **DigitalOcean Basic Droplet:** $4.00/mo — 1 vCPU, 512 MB RAM, 10 GB SSD.

---

## 3. Production Environment Variables (`.env`)

Store these securely on the server (e.g. `/etc/wacrm-qr-service/.env` or Docker environment):

```bash
# Server Port & Binding (0.0.0.0 inside container, or 127.0.0.1 behind reverse proxy)
PORT=8790
HOST=0.0.0.0

# Shared HMAC-SHA256 Secret (Must match QR_BRIDGE_SECRET set on Cloudflare wacrm-api Worker)
QR_BRIDGE_SECRET=your-secure-random-32-character-secret-key-here

# AES-256-GCM Key used to encrypt session tokens on the persistent volume
QR_SESSION_ENCRYPTION_KEY=your-secure-random-32-character-session-encryption-key

# Persistent storage mount point for Baileys session files and media
QR_STORAGE_DIR=/var/lib/wacrm-qr-sessions

# Production Webhook URL pointing to your Cloudflare API Worker
API_WEBHOOK_URL=https://wacrm-api.awais-wacrm-2026.workers.dev/webhooks/qr-bridge

# QR expiration time in milliseconds (default 60s)
QR_TTL_MS=60000
```

---

## 4. Deployment Option A: Docker Compose + Caddy (Recommended)

### `docker-compose.yml`
```yaml
version: '3.8'

services:
  qr-bridge:
    build:
      context: .
      dockerfile: apps/qr-service/Dockerfile
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - qr_storage:/var/lib/wacrm-qr-sessions
    networks:
      - internal

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - internal
    depends_on:
      - qr-bridge

volumes:
  qr_storage:
  caddy_data:
  caddy_config:

networks:
  internal:
```

### `Caddyfile` (Automatic Let's Encrypt SSL)
```caddy
qr-bridge.yourdomain.com {
    reverse_proxy qr-bridge:8790
}
```

---

## 5. Deployment Option B: Systemd Service on Linux VPS

If running directly on Ubuntu/Debian:

```bash
# 1. Create service user and data directory
sudo useradd -r -s /bin/false wacrm
sudo mkdir -p /var/lib/wacrm-qr-sessions
sudo chown -R wacrm:wacrm /var/lib/wacrm-qr-sessions

# 2. Place files in /opt/wacrm-qr-service
sudo mkdir -p /opt/wacrm-qr-service
# (Copy repository or apps/qr-service + packages)
cd /opt/wacrm-qr-service
pnpm install --frozen-lockfile --prod

# 3. Create systemd unit: /etc/systemd/system/wacrm-qr.service
```

`/etc/systemd/system/wacrm-qr.service`:
```ini
[Unit]
Description=WhatsApp Booster Pro QR Bridge Service
After=network.target

[Service]
Type=simple
User=wacrm
WorkingDirectory=/opt/wacrm-qr-service
EnvironmentFile=/opt/wacrm-qr-service/.env
ExecStart=/usr/bin/node apps/qr-service/src/server.ts
Restart=always
RestartSec=5s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wacrm-qr
sudo systemctl status wacrm-qr
```

---

## 6. Connecting Cloudflare `wacrm-api` to the QR Bridge

Once the persistent QR bridge is live on its HTTPS domain (e.g. `https://qr-bridge.yourdomain.com`), set the secrets on the Cloudflare API Worker:

```bash
# Set the Bridge URL on Cloudflare API Worker
pnpm.cmd --filter @wacrm/api exec wrangler secret put QR_BRIDGE_URL
# Input: https://qr-bridge.yourdomain.com

# Set the Bridge HMAC secret on Cloudflare API Worker
pnpm.cmd --filter @wacrm/api exec wrangler secret put QR_BRIDGE_SECRET
# Input: (Same secret configured in your server .env)
```

The API Worker will automatically authenticate with the QR bridge using signed HMAC-SHA256 headers for all session operations (`start`, `refresh`, `reconnect`, `disconnect`, and `send`).
