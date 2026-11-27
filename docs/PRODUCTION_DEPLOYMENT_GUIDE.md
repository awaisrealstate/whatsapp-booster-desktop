# WhatsApp Booster Pro — Production Deployment Guide

**Target Architecture:** Cloudflare Workers (`wacrm-api`, `wacrm-engine`), Cloudflare D1 (`wacrm-db`), Cloudflare Queues (`wacrm-jobs`), Cloudflare Workers AI (`env.AI`), Cloudflare Pages (`wacrm-web`).  
**Infrastructure Cost Target:** \$0 Cloudflare Free Tier compatible (no R2 bucket activated).

---

## 1. Prerequisites

1. Node.js (`v20+` or current LTS) and `pnpm@12.23.0` installed locally.
2. Cloudflare account created (Free Tier is sufficient for staging and initial launch).
3. Wrangler CLI logged in (`npx wrangler login`).
4. Strong 32+ character random `ENCRYPTION_KEY` generated cleanly (for example via PowerShell `[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))` or OpenSSL).

---

## 2. Pre-Deployment Verification Commands (Local)

Run from `d:\Whatsapp Booster Desktop`:

```powershell
# 1. Verify TypeScript types across all 6 workspace packages
pnpm.cmd -r typecheck

# 2. Run all unit & integration tests (expect 60 passed, 0 failed)
pnpm.cmd -r test

# 3. Verify Wrangler API and Background Worker bundle dry-runs
npx.cmd wrangler deploy apps/api/src/index.ts --config apps/api/wrangler.example.jsonc --dry-run
npx.cmd wrangler deploy apps/worker/src/index.ts --config apps/worker/wrangler.example.jsonc --dry-run
```

Verified dry-run bundle sizes:
- `apps/api` (`wacrm-api`): `858.47 KiB` total (`161.24 KiB` gzip)
- `apps/worker` (`wacrm-engine`): `246.60 KiB` total (`49.89 KiB` gzip)

Both sit well inside the Cloudflare Workers Free `3 MiB` compressed upload limit.

---

## 3. Configuration Files (Never Commit Real `wrangler.jsonc` / `.dev.vars`)

Keep example files tracked in Git and copy them locally when provisioning:

| Component | Template File | Local Working Config (`.gitignore`d) |
| :--- | :--- | :--- |
| API Worker | [apps/api/wrangler.example.jsonc](file:///d:/Whatsapp%20Booster%20Desktop/apps/api/wrangler.example.jsonc) | `apps/api/wrangler.jsonc` |
| API Dev Secrets | [apps/api/.dev.vars.example](file:///d:/Whatsapp%20Booster%20Desktop/apps/api/.dev.vars.example) | `apps/api/.dev.vars` |
| Engine Worker | [apps/worker/wrangler.example.jsonc](file:///d:/Whatsapp%20Booster%20Desktop/apps/worker/wrangler.example.jsonc) | `apps/worker/wrangler.jsonc` |
| Engine Dev Secrets | [apps/worker/.dev.vars.example](file:///d:/Whatsapp%20Booster%20Desktop/apps/worker/.dev.vars.example) | `apps/worker/.dev.vars` |
| Web Frontend | [apps/web/wrangler.example.jsonc](file:///d:/Whatsapp%20Booster%20Desktop/apps/web/wrangler.example.jsonc) | `apps/web/wrangler.jsonc` |

Note: [`.gitignore`](file:///d:/Whatsapp%20Booster%20Desktop/.gitignore) ignores `wrangler.jsonc`, `.dev.vars`, `.env`, and `user_data/`.

---

## 4. Production Deployment Sequence

### Step A — Create D1 Database & Apply Migrations (`0001`–`0005`)

```powershell
npx.cmd wrangler d1 create wacrm-db
```

Copy the returned `database_id` into `"database_id"` in both `apps/api/wrangler.jsonc` and `apps/worker/wrangler.jsonc`, then apply all 5 SQL migrations remotely:

```powershell
npx.cmd wrangler d1 migrations apply wacrm-db --config apps/api/wrangler.jsonc --remote
```

Migrations applied (in order from [packages/db/migrations](file:///d:/Whatsapp%20Booster%20Desktop/packages/db/migrations)):
1. `0001_init.sql`
2. `0002_auth_rate_limits.sql`
3. `0003_phase2_crm.sql`
4. `0004_phase3_meta_campaigns.sql`
5. `0005_phase5_7_ai_auth_saas.sql`

### Step B — Create Cloudflare Queue

```powershell
npx.cmd wrangler queues create wacrm-jobs
```

This matches `"queue": "wacrm-jobs"` (`env.JOBS_QUEUE`) in both `apps/api/wrangler.jsonc` and `apps/worker/wrangler.jsonc`.

### Step C — Configure Production Environment Variables & Secrets

In `apps/api/wrangler.jsonc`:
- Set `"APP_ENV": "production"`
- Set `"PASSWORD_AUTH_ENABLED": "false"` (recommended on Free Tier)
- Set `"WEB_APP_URL"` to your Pages URL (for example `https://wacrm-web.pages.dev`)
- Set `"ALLOWED_ORIGINS"` strictly to your exact Pages / custom frontend origins (for example `https://wacrm-web.pages.dev`)

Push secrets interactively using Wrangler (never place real secrets in `wrangler.jsonc`):

```powershell
# Same ENCRYPTION_KEY (>= 32 chars) on BOTH Workers:
npx.cmd wrangler secret put ENCRYPTION_KEY --config apps/api/wrangler.jsonc
npx.cmd wrangler secret put ENCRYPTION_KEY --config apps/worker/wrangler.jsonc

# Google OAuth2 (recommended for PKCE login):
npx.cmd wrangler secret put GOOGLE_CLIENT_ID --config apps/api/wrangler.jsonc
npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET --config apps/api/wrangler.jsonc

# Optional GitHub OAuth2:
npx.cmd wrangler secret put GITHUB_CLIENT_ID --config apps/api/wrangler.jsonc
npx.cmd wrangler secret put GITHUB_CLIENT_SECRET --config apps/api/wrangler.jsonc

# Optional platform fallback Meta secrets:
npx.cmd wrangler secret put META_APP_SECRET --config apps/api/wrangler.jsonc
npx.cmd wrangler secret put META_WEBHOOK_VERIFY_TOKEN --config apps/api/wrangler.jsonc
```

### Step D — Deploy `wacrm-api` & `wacrm-engine`

```powershell
npx.cmd wrangler deploy apps/api/src/index.ts --config apps/api/wrangler.jsonc
npx.cmd wrangler deploy apps/worker/src/index.ts --config apps/worker/wrangler.jsonc
```

### Step E — Deploy Static Dashboard (`apps/web`) to Cloudflare Pages

```powershell
npx.cmd wrangler pages deploy apps/web --project-name wacrm-web
```

Open your deployed Cloudflare Pages site, enter your `https://wacrm-api.<subdomain>.workers.dev` base URL if prompted (or save it in API Base URL), and sign in with Google/GitHub OAuth2.

---

## 5. Free-Tier Operating Limits & Guardrails

| Cloudflare Service | Free Tier Limit | Platform Mitigation Built In |
| :--- | :--- | :--- |
| **Workers CPU** | `10 ms` per HTTP request | `PASSWORD_AUTH_ENABLED=false` defaults to OAuth2 PKCE; heavy batch sends offloaded to Queue & Cron (`*/2 * * * *`). |
| **D1 Writes / Reads** | `100k` writes/day, `5M` reads/day | Chunked writes (`D1_SAFE_IN_CHUNK_SIZE = 80`), SQLite indexes, visibility-aware `20_000 ms` polling instead of `1s` polling. |
| **Queues** | `10,000` ops/day | Batched `10` recipient IDs per Queue message (`max_batch_size: 10`), inline/pending fallback cleanly preserves D1 state on quota exhaustion. |
| **Workers AI** | `10,000` Neurons/day | Daily per-organization `dailyReplyLimit` and `dailyNeuronLimit` caps + short FTS5 Knowledge Base prompts + manual human handoff fallback. |
| **Cron Triggers** | `5` triggers max | Single consolidated Cron (`*/2 * * * *`) on `wacrm-engine`. |
| **Meta WhatsApp Billing** | Meta charges templates from message `#1` | Use Meta Test Number + verified test recipients during validation; Service replies inside 24h windows (`1,000`/month free tier per Meta WABA rules). |
