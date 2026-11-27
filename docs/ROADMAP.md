# Project Roadmap — WhatsApp Booster Pro (Phase 0–8)

**Audit Date:** 2026-11-26  
**Methodology:** Every phase executes via bounded **Loop Engineering** (`INSPECT → PLAN → IMPLEMENT → TEST → REVIEW → FIX → VERIFY`). No phase advances with failing or skipped tests.

---

## Phase 0 — Repository Audit *(Current Phase — Stop & Wait for Approval)*
- Inspect entire repository (`main.js`, `index.html`, `desktop.css`, `Start-Whatsapp-Booster.bat`, `package.json`, `package-lock.json`, `engine/`, `ui/`), dependencies, licenses, and security posture.
- Produce the 9 audit and architecture planning documents in `docs/`.
- **Gate:** Explicit user approval before any code, database, or deployment changes.

## Phase 1 — Backend Foundation
- Initialize monorepo workspace (`packages/shared`, `packages/db`, `apps/api`) while keeping the existing Electron app untouched/functional.
- Extract pure shared utilities (`normalizePhone`, `parseCSVText`, `mergeContactsPreserveProgress`, bounded `formatMessageText`) into `packages/shared` with unit tests.
- Scaffold `apps/api` (**Cloudflare Workers + Hono + TypeScript**) and `packages/db` (**Cloudflare D1 + Drizzle ORM** SQL migrations).
- Implement baseline authentication (users, sessions), secrets configuration (`wrangler secret` / `.dev.vars.example`), and Cloudflare R2 binding.
- Harden immediate desktop security risks (`xlsx@0.18.5` replacement, CSV formula injection fix, Electron `contextIsolation` / `postMessage` plan).

## Phase 2 — CRM
- Implement core CRM tables and endpoints: `contacts`, `tags`, `contact_tags`, `contact_lists`, `list_members`, `consent_records` (opt-in / `STOP` opt-out tracking), `conversations`, and `messages`.
- Build browser-side CSV/XLSX contact importer + Legacy `user_data/campaign_state.json` Importer (non-destructive).
- Introduce gradual responsive UI views on Cloudflare Pages for Contact Directory, Pipeline Stages, Tags, and Conversation Threads.

## Phase 3 — Official WhatsApp API
- Build `packages/providers` with the unified `WhatsAppProvider` interface and `MetaCloudProvider` (`official_meta_cloud`) as the commercial default.
- Implement `whatsapp_accounts` with AES-256-GCM encrypted Meta credentials and `templates` sync.
- Implement `GET/POST /webhooks/meta` with HMAC-SHA256 `X-Hub-Signature-256` verification, idempotent `provider_message_id` ingestion, delivery/read receipt updates, and 24-hour customer care window enforcement.

## Phase 4 — Cloud Campaign Execution
- Scaffold `apps/worker` with Cloudflare Queues consumer and consolidated Cron Triggers (`*/2 * * * *`, `*/15 * * * *`).
- Persist `campaigns` and `campaign_recipients` durably in D1 with unique `idempotency_key` deduplication and safe retry handling so scheduled campaigns execute without the user's laptop.
- Migrate Google Sheet auto-sync to the cloud Cron worker with HTTPS + `docs.google.com` SSRF allowlisting and `consent_records` opt-out suppression.

## Phase 5 — AI Customer Support
- Implement `ai_agents`, `knowledge_docs`, and SQLite FTS5 (`knowledge_fts`) retrieval inside D1.
- Integrate **Cloudflare Workers AI** in the Queue consumer for inbound customer support replies inside active 24-hour service windows.
- Enforce per-organization daily Neuron quotas, concise prompt templates, and automatic AI-to-human handoff on low confidence or escalation keywords.

## Phase 6 — Optional Local WhatsApp Connector
- Harden Electron (`main.js`: `nodeIntegration: false`, `contextIsolation: true`, `webSecurity: true`, `contextBridge` preload, `postMessage` origin verification, scoped `User-Agent`).
- Refactor Electron into an optional thin desktop client hosting the web dashboard with native tray/notifications.
- Isolate existing `engine/content.js` DOM automation strictly as an opt-in `unofficial_local_desktop` provider behind explicit ToS risk acknowledgment (`unofficial_risk_accepted_at`), polling queued local jobs over HTTPS without running DOM automation in Cloudflare Workers.

## Phase 7 — Multi-Tenant SaaS
- Enforce full `organizations` and `organization_members` RBAC (`owner`, `admin`, `agent`, `viewer`) across all API routes, D1 queries, and R2 object prefixes.
- Implement `usage_counters` plan quotas, `audit_logs`, organization switching, member invitations, and billing-hook abstractions.

## Phase 8 — Production Hardening
- Add GitHub Actions CI/CD (typecheck, lint, unit/integration tests, D1 migrations, Wrangler/Pages deploys) and `electron-builder` Windows installer builds.
- Execute cross-tenant isolation tests, webhook replay/signature tests, Free-Tier CPU (`10 ms`) & D1 write-budget load checks, and disaster recovery / backup runbooks.

---

## Phase 1A Implementation Log (2026-11-26)

### Implemented Foundation
- **Workspace Monorepo:** Added `pnpm-workspace.yaml` and `tsconfig.base.json` alongside existing Electron files (`main.js`, `index.html`, `ui/`, `engine/` left in place).
- **`packages/shared` (`@wacrm/shared`):** Pure TypeScript modules (`phone.ts`, `contact.ts`, `template.ts`, `csv.ts`) with E.164 digit validation (`8..15`), Smart Merge, bounded Spintax (`MAX_SPINTAX_PASSES = 20`), `MAX_MESSAGE_LENGTH = 4096`, and CSV formula injection neutralization. **14/14 unit tests passing.**
- **`packages/db` (`@wacrm/db`):** Drizzle ORM schema + `migrations/0001_phase1a_foundation.sql` (`users`, `organizations`, `organization_members`, `sessions`), WebCrypto PBKDF2-SHA256 (`<= 100,000` iterations) + SHA-256 `tokenHash`, default owner organization creation on registration, and application-layer membership enforcement. **5/5 tests passing** against an in-memory `node:sqlite` D1 adapter.
- **`apps/api` (`@wacrm/api`):** Hono + Zod Cloudflare Worker foundation (`GET /health`, `GET /api/v1/status`, `POST /api/v1/validate/contact`, `GET /api/v1/orgs/current`), strict `ALLOWED_ORIGINS` CORS, centralized error handler, structured redacted JSON logger, and `wrangler.example.jsonc` / `.dev.vars.example`. **7/7 tests passing.**

### Known Blockers & Deferred Subtasks
- **Excel Parser Replacement (`xlsx@0.18.5`):** Subtask stopped to avoid breaking `.xls` imports (`read-excel-file` and `exceljs` do not support binary `.xls`, and `ui/dashboard.html` has no bundler). Requires decision in Phase 2 to either drop legacy `.xls` support in favor of `read-excel-file` (`.xlsx` + `.csv`) or evaluate a patched bundle.
- **Production Auth Delivery:** Password reset and email verification flows require an approved email delivery provider (e.g., Resend/Postmark/SMTP) or OAuth2 decision; not invented in Phase 1A.

---

## Phase 1B Completion Update (2026-11-26)
- **Electron Compatibility Restored:** Configured `allowBuilds: { electron: true }` in `pnpm-workspace.yaml` (`pnpm@12.23.0`), verified `node_modules/electron/dist/electron.exe` (`v45.5.0`), and confirmed `Start-Whatsapp-Booster.bat` launches `"Whatsapp Booster With Awais - Desktop Edition"`.
- **Security Hardening:** Fixed `template.ts` `$`-pattern substitution, extended `sanitizeCsvCell` to `\n` and leading whitespace before formula chars, added `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Access-Control-Expose-Headers: X-Request-Id`, and recursive array+object log redaction in `apps/api`.
- **Auth Foundation & Gate:** Added `0002_phase1b_auth_foundation.sql` (`verification_tokens`, `auth_rate_limits`), `EmailSender` port (`UnconfiguredEmailSender`), and `/api/v1/auth/{register,login,logout,me}`. Password `register`/`login` remain gated (`PASSWORD_AUTH_ENABLED=false`) pending live Cloudflare CPU verification or OAuth2/magic-link pivot. See `docs/PHASE_1B_REPORT.md`.

---

## Phase 2 Completion Update (2026-11-26)
- **Database (`0003_phase2_crm.sql`):** Implemented `contacts` (soft delete + active-phone unique index), `tags`, `contact_tags`, `contact_lists`, `list_members`, durable `consent_records` (`ON DELETE SET NULL`), `suppression_list`, `conversations`, `messages`, and `legacy_imports`.
- **CRM API (`/api/v1/crm/*`):** Full CRUD, search, tags, lists, consent & STOP suppression eligibility, conversations/messages, safe CSV/TSV/`read-excel-file` `.xlsx` import preview/commit (explicitly rejecting binary `.xls`), and non-destructive `legacy-import` dry-run/commit.
- **Desktop Integration:** Added non-breaking `exportLegacyState` (`📤 Export State JSON`) in `ui/bridge.js` + `ui/dashboard.html` + `ui/dashboard.js` without connecting to undeployed APIs. See `docs/PHASE_2_REPORT.md`.

---

## Phase 3 & Core Cloud Platform Completion Update (2026-11-27)
- **Official Meta Cloud API (`packages/providers`, `0004_phase3_meta_campaigns.sql`):** Implemented `WhatsAppProvider`, `MetaCloudProvider`, AES-256-GCM encrypted Meta credentials (`whatsapp_accounts`), Meta template creation/sync (`templates`), HMAC-SHA256 `X-Hub-Signature-256` verified `/webhooks/meta`, idempotent `webhook_events`, 24h customer care window enforcement, and automatic English/Urdu `STOP` suppression.
- **Durable Cloud Campaign Engine (`packages/db/src/campaigns.ts`, `apps/worker`):** Implemented `campaigns`, `campaign_recipients`, `usage_counters`, scheduled Cron promotion (`*/2 * * * *`), batched Cloudflare Queues dispatch with D1 quota fallback, `idempotency_key` deduplication, exponential retries, daily usage limits, pause/resume/cancel, and delivery reporting.
- **Responsive Cloud Dashboard (`apps/web`) & Verification:** Added static Cloudflare Pages UI covering Contacts, Lists, Tags, Meta Connection, Templates, Campaigns, Delivery Reports, and Inbox (`56 / 56` workspace tests passing + local Wrangler D1 + Electron `v45.5.0` verified). See `docs/FINAL_BUILD_1_REPORT.md`.
