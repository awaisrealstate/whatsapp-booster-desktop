# Cloud Deployment Plan — Cloudflare & GitHub (Phase 0)

**Audit Date:** 2026-11-26  
**Status:** **PROPOSAL ONLY** — Nothing has been deployed or provisioned during Phase 0.  
**Target Budget:** \$0 initial infrastructure using Cloudflare Free Tier and GitHub.

---

## 1. Cloudflare Workers & Resource Topology

| Resource | Binding / Name | Purpose |
| :--- | :--- | :--- |
| **API & Webhook Worker** | `wacrm-api` | Hono + TypeScript REST API, authentication, organization RBAC, Meta Cloud API webhook endpoint, optional Desktop Bridge pull/ack API. |
| **Background Engine Worker** | `wacrm-engine` | Scheduled Cron handlers (due campaigns, sheet sync, token cleanup), Cloudflare Queue batch consumer, Workers AI support bot execution. |
| **D1 Database** | `DB` (`wacrm-db`) | Durable relational store shared by `wacrm-api` and `wacrm-engine` via Drizzle ORM. |
| **Cloudflare Queue** | `JOBS_QUEUE` (`wacrm-jobs`) | Asynchronous dispatch queue (`campaign_batch`, `ai_reply`, `webhook_process`, `sheet_sync`) with dead-letter retry handling. |
| **R2 Bucket** | `MEDIA_BUCKET` (`wacrm-media`) | Media attachments, knowledge documents, and temporary CSV/XLSX exports (with object lifecycle expiration). |
| **Workers AI** | `AI` | Free-tier-eligible LLM inference for customer support bot replies. |
| **Cron Triggers** | `*/2 * * * *`, `*/15 * * * *` | Consolidated into 2 triggers (within the 5-trigger Free-plan limit) to promote scheduled campaigns and sync Google Sheets. |
| **Frontend Hosting** | Cloudflare Pages (`wacrm-web`) | Hosts static dashboard assets (HTML/CSS/JS or Vite SPA). Static assets avoid consuming Worker request quotas (subject to Cloudflare Free-plan ToS/fair-use; Pages Functions *do* consume Worker quotas so API calls go directly to `wacrm-api`). |

---

## 2. Proposed Monorepo Structure

```text
whatsapp-booster-pro/
├── apps/
│   ├── web/              # Responsive static SPA -> Cloudflare Pages
│   ├── api/              # Cloudflare Worker (Hono): Auth, CRM API, Meta Webhooks
│   ├── worker/           # Cloudflare Worker: Cron Triggers, Queue Consumer, AI Bot
│   └── desktop/          # Hardened Electron thin client + opt-in local WA bridge
├── packages/
│   ├── db/               # Drizzle schema + D1 SQL migrations
│   ├── providers/        # WhatsAppProvider interface, MetaCloudProvider, LocalBridgeProvider
│   └── shared/           # Phone normalizer, CSV/paste parser, template renderer, types
└── .github/workflows/    # CI tests + Wrangler/Pages deployment automation
```

---

## 3. Environment Variables & Secrets Management

### Non-Secret Environment Variables (`wrangler.jsonc` / `wrangler.toml`)
- `APP_ENV` (`development` | `staging` | `production`)
- `WEB_ORIGIN` (allowed CORS origin for `apps/web`)
- `META_GRAPH_VERSION` (`v21.0`)
- `MAX_AI_NEURONS_PER_ORG_DAILY` (quota safeguard)

### Sensitive Secrets (Never Committed to Git)
- **Production / Staging:** Managed via `wrangler secret put <NAME>` (or GitHub Actions encrypted secrets):
  - `JWT_SECRET` — Session / desktop token signing key
  - `ENCRYPTION_KEY` — 32-byte AES-256-GCM master key for encrypting per-organization Meta credentials stored in D1
  - `META_APP_SECRET` & `META_WEBHOOK_VERIFY_TOKEN` — Webhook validation
- **Local Development:** Stored only in `.dev.vars` (strictly listed in `.gitignore`). Only `.dev.vars.example` and `wrangler.example.jsonc` (containing placeholder IDs) are committed.

---

## 4. Development vs. Production Environments

| Dimension | Local Development | Production (Free Tier) |
| :--- | :--- | :--- |
| **API & Worker** | `wrangler dev --local` (Miniflare local simulation) | Deployed to `wacrm-api` and `wacrm-engine` Workers via GitHub Actions |
| **Database** | Local SQLite D1 via `wrangler d1 migrations apply --local` | Remote D1 `wacrm-db` via `wrangler d1 migrations apply --remote` |
| **Queues & Cron** | Simulated via Wrangler local queue/scheduled test endpoints | Managed Cloudflare Queues + 2 Cron Triggers |
| **Meta Webhooks** | Local tunnel (`cloudflared tunnel`) to test webhook callbacks | Public HTTPS Worker route `POST /webhooks/meta` |
| **Desktop Client** | `electron .` pointing to local `apps/web` or local `wrangler dev` URL | Packaged Windows installer built via `electron-builder` in GitHub Actions and distributed via GitHub Releases |
