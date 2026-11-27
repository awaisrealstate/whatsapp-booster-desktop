# Architecture Analysis — WhatsApp Booster Pro (Phase 0)

**Audit Date:** 2026-11-26  
**Repository:** `https://github.com/awaisrealstate/whatsapp-booster-desktop` (commit `29a1ced`)  
**Scope:** Verified architecture of the existing Electron desktop application and evaluation of the proposed Cloudflare SaaS target architecture.

> **Epistemic Tagging:** Throughout this document, **Verified Facts** come directly from inspecting repository source files; **Assumptions** mark unexecuted runtime behaviors or external platform constraints; **Recommendations** mark proposed Phase 1–8 design choices.

---

## 1. Existing Application Architecture (Verified Facts)

The current repository is a **single-user Electron desktop application** (`electron ^45.5.0`) that wraps a dashboard originally authored as a Chrome Extension (`WhatsApp CRM Pro`) alongside an embedded WhatsApp Web `<webview>`.

### 1.1 Electron Process & Container Structure

1. **Main Process (`main.js`):**
   - Requests a single-instance OS lock (`app.requestSingleInstanceLock()`, `main.js#L65`).
   - Redirects Electron `userData` to `./user_data/` (`main.js#L6-L10`) and persists two local JSON files atomically via `.tmp` write + `fs.renameSync`: `campaign_state.json` and `app_settings.json`.
   - Creates a `BrowserWindow` (`1320×880`, min `1024×700`) with `nodeIntegration: true`, `contextIsolation: false`, `webviewTag: true`, and `webSecurity: false` (`main.js#L123-L128`), loading `index.html`.
   - Rewrites the `User-Agent` header on all `session.defaultSession` requests to `Chrome/126.0.0.0` (`main.js#L192-L195`).
   - Manages a Windows/desktop System Tray (`createTray()`), close-to-tray behavior (`minimizeToTray`), native `Notification` popups, and OS login autostart (`app.setLoginItemSettings`).

2. **Host Renderer Process (`index.html` + `desktop.css`):**
   - Renders the top navigation bar with three view modes: **Control Dashboard**, **WhatsApp Live View**, and **Split View** (50/50 CSS layout).
   - Hosts two isolated sub-contexts inside `#viewport`:
     - `<iframe id="dashboard-frame" src="ui/dashboard.html">`
     - `<webview id="wa-webview" src="https://web.whatsapp.com" partition="persist:whatsapp_booster_session" preload="engine/preload.js">`
   - Acts as an event router: polls `waWebview.send('check-connection')` every `4000ms` (`index.html#L158`), translates `window.postMessage` events from the dashboard `<iframe>` into `waWebview` IPC or `ipcRenderer` calls to `main.js`, and forwards responses back into `dashboardFrame.contentWindow.postMessage`.

3. **Dashboard `<iframe>` (`ui/dashboard.html`, `ui/dashboard.js`, `ui/bridge.js`, `ui/lib/*`):**
   - `ui/dashboard.js` is written against Chrome Extension APIs (`chrome.runtime.sendMessage`, `chrome.runtime.connect`) and polls `getState` + `checkWhatsAppStatus` every `1000ms` (`ui/dashboard.js#L739-L742`).
   - `ui/bridge.js` supplies a `window.chrome` compatibility shim (`storage.local`, `runtime.sendMessage`, `runtime.connect`) backed by `localStorage` (`wacrm_desktop_state`) plus `Orchestrator`, an in-memory state machine with `setInterval`/`setTimeout` timers.
   - `ui/lib/csv-parser.js` (`window.WACRMParser`) and `ui/lib/xlsx.full.min.js` (SheetJS `0.18.5`) handle spreadsheet/text ingestion and phone normalization.

4. **WhatsApp `<webview>` Process (`engine/preload.js` + `engine/content.js`):**
   - `engine/preload.js` runs in the `<webview>` preload context. On `DOMContentLoaded`, it reads `engine/content.js` via Node `fs.readFileSync` and injects it as an inline `<script>` element directly into the `web.whatsapp.com` DOM (`engine/preload.js#L8-L21`).
   - It listens to `check-connection` (inspecting WhatsApp DOM selectors `#pane-side`, QR `<canvas>`, loading indicators) and `send-single-message` (reposting via `window.postMessage` as `WACRM_DESKTOP_DISPATCH`), and forwards `WACRM_DESKTOP_RESULT` back to `index.html` via `ipcRenderer.sendToHost`.

---

## 2. Existing Component Relationships & Data Flow

```text
+-----------------------------------------------------------------------+
| Electron Main Process (main.js)                                       |
|  - Single-instance lock, Tray, OS Notifications, Login Item           |
|  - user_data/campaign_state.json & user_data/app_settings.json        |
|  - session.defaultSession User-Agent rewrite (Chrome/126.0.0.0)       |
+-----------------------------------^-----------------------------------+
                                    | ipcRenderer.invoke / send
+-----------------------------------v-----------------------------------+
| Host Renderer Window (index.html)                                     |
|  - 4000ms polling loop -> waWebview.send('check-connection')          |
|  - Message router between iframe (postMessage) and webview (IPC)      |
+-----------------+-----------------------------------+-----------------+
                  | window.postMessage('*')           | webview.send /
                  |                                   | ipc-message
+-----------------v-----------------+   +-------------v-----------------+
| Dashboard <iframe>                |   | <webview> web.whatsapp.com    |
|  ui/dashboard.html + dashboard.js |   |  partition: persist:whatsapp_ |
|  (polls chrome.runtime every 1s)  |   |  booster_session              |
|                 |                 |   |                               |
|  ui/bridge.js (chrome.* shim +    |   |  engine/preload.js            |
|  Orchestrator timers + localStore)|   |   -> injects engine/content.js|
|  ui/lib/csv-parser.js + xlsx.js   |   |      into page <script>       |
+-----------------------------------+   +-------------------------------+
```

### Outbound Dispatch Data Flow (Verified in Source Code)
1. User clicks Start in `ui/dashboard.html` -> `dashboard.js` calls `chrome.runtime.sendMessage({ action: 'startCampaign' })`.
2. `ui/bridge.js` sets `isRunning = true`, saves state to `localStorage` and sends `HOST_SAVE_STATE` to `index.html` -> `main.js` writes `campaign_state.json`.
3. `Orchestrator.dispatchNext()` checks `navigator.onLine` and `lastWaStatus`, formats `{name}` / `{company}` / Spintax, and posts `DESKTOP_EXECUTE_DISPATCH` to `index.html`.
4. `index.html` sends `send-single-message` IPC to `waWebview` -> `engine/preload.js` posts `WACRM_DESKTOP_DISPATCH` to `window`.
5. `engine/content.js` executes `Automator.sendToContact()`:
   - Checks `dispatchToken` set, 20-second per-phone timestamp lock, and `isSendingLock`.
   - Opens the "New chat" drawer (`openNewChatDrawer()`), types up to 4 phone/name query formats into the search input, selects a result via multi-event `robustClick()` + `ArrowDown`/`Enter`, and checks `#main header` against `previousChatHeader` before pasting and clicking Send.
   - Posts `WACRM_DESKTOP_RESULT` -> `preload.js` `sendToHost('dispatch-result')` -> `index.html` `HOST_DISPATCH_RESULT` -> `bridge.js` updates `sentPhoneHistory` and schedules the next contact via `setTimeout`.

---

## 3. Current WhatsApp Connection Mechanism (Verified Facts)

- **Mechanism:** Embedded Chromium `<webview>` loading `https://web.whatsapp.com` with persistent storage partition `persist:whatsapp_booster_session` stored under `./user_data/Partitions/`.
- **Authentication:** Manual QR code scan on WhatsApp Web inside the "WhatsApp Live View" or "Split View" tab.
- **Session Detection:** `engine/preload.js#L24-L52` checks DOM selectors (`#pane-side`, `#side`, `[data-testid="chat-list"]`, `#app header`, `#main`, `.two` for connected; `canvas`, `div[data-ref]`, `[data-testid="qrcode"]` for QR; `progress`, `[data-testid="intro-loading"]`, `#initial_startup` for loading). Note that `engine/content.js` defines a slightly different `getConnectionStatus()` (`content.js#L101-L132`) whose `WACRM_DESKTOP_CHECK_CONN` listener (`content.js#L735`) is unused.
- **Limitations:** Completely dependent on the user's laptop being powered on, awake, and connected; lacks inbound message reception/webhooks; breaks if WhatsApp Web changes internal DOM attributes.

---

## 4. Evaluation of Proposed Target Cloudflare Architecture (Recommendations)

### Architectural Decisions Evaluated

| Proposed Component | Evaluation & Verdict | Architectural Rationale |
| :--- | :--- | :--- |
| **Cloudflare Workers + Hono + TypeScript** | **Adopt (Recommended)** | `Hono` adds minimal bundle/CPU overhead, fitting well within the Workers Free `10 ms` CPU time ceiling per invocation while giving typed routing, middleware, and validation. |
| **Cloudflare D1 + Drizzle ORM** | **Adopt (Recommended)** | Relational SQLite at the edge acts as the durable source of truth for multi-tenant CRM data, scheduled campaigns, recipients, consent records, and audit logs. Drizzle provides typed schema/migrations with minimal runtime weight. |
| **Cloudflare Queues** | **Adopt with Batching (Recommended)** | Decouples webhook ingestion and campaign scheduling from Worker execution timeouts. Messages must carry `idempotency_key` + attempt limits so retries never duplicate WhatsApp sends. |
| **Cloudflare Cron Triggers** | **Adopt Consolidated (Recommended)** | Schedules due campaigns, recurring messages, and Google Sheet syncs independently of any laptop. Consolidate into 1–2 cron schedules to stay within the 5-trigger Free account cap. |
| **Cloudflare R2** | **Adopt (Recommended)** | Stores inbound/outbound media, knowledge documents, and CSV/XLSX exports outside D1's `500 MB` DB cap, with lifecycle expiration rules to fit the `10 GB` free allowance. |
| **Workers AI** | **Adopt with Guardrails (Recommended)** | Powers the Phase 5 customer support bot using compact free-eligible models, paired with D1 FTS5 pre-filtering and per-organization daily Neuron caps (`10,000 Neurons/day` account budget). |
| **Existing Electron App** | **Retain as Optional Thin Desktop Client** | Hardened (`contextIsolation: true`, `nodeIntegration: false`) to host the web dashboard with native tray/notifications, plus an strictly isolated, opt-in local connector mode. |

### Target Hybrid Cloud Architecture

```text
+-------------------------+        +------------------------------------+
| Responsive Web UI       |        | Optional Electron Desktop Client   |
| (Cloudflare Pages)      |        | - Hardened shell + tray            |
+------------+------------+        | - Optional Local Unofficial Bridge |
             | HTTPS               +---------+-------------------+------+
             | (Auth + Workspace)            | HTTPS             | Local IPC
             v                               v                   | (Opt-in)
+--------------------------------------------+----+              v
| Cloudflare Worker: API & Webhooks (Hono + TS)   |     +-----------------+
| - Auth, RBAC, Org Isolation, Consent Enforcement|     | Local WA Web    |
| - Meta Cloud Webhook (X-Hub-Signature-256)      |     | <webview> /     |
+--------+-----------------------------+----------+     | Local Bridge    |
         |                             |                +-----------------+
         v                             v
+-----------------+           +-------------------+
| Cloudflare D1   |           | Cloudflare Queues |
| (Drizzle ORM)   |<--------->| (Idempotent Jobs) |
| Durable Truth   |           +---------+---------+
+--------+--------+                     |
         ^                              v
         |                    +-------------------+     +-----------------+
+--------+--------+           | Consumer & Cron   |---->| Workers AI / R2 |
| Cron Triggers   |---------->| Worker            |     +-----------------+
| (Schedules/Sync)|           +---------+---------+
+-----------------+                     |
                                        v
                        +-------------------------------+
                        | WhatsAppProvider Interface    |
                        +---------------+---------------+
                                        |
                       +----------------+----------------+
                       v                                 v
        +-----------------------------+   +-----------------------------+
        | MetaCloudProvider (DEFAULT) |   | LocalBridgeProvider (OPT-IN)|
        | Official Graph API          |   | Desktop pull / user sidecar |
        +-----------------------------+   +-----------------------------+
```

### Key Architectural Guarantees
1. **D1 as Durable Source of Truth:** Every scheduled campaign, recipient state (`pending`, `queued`, `sent`, `delivered`, `read`, `failed`, `skipped`), and consent state lives in D1 rather than browser `localStorage` or `setTimeout`.
2. **Idempotent, Safely Retriable Queue Processing:** Every outbound job references a unique `idempotency_key` (`messages.idempotency_key` / `campaign_recipients` unique `(campaign_id, contact_id)`) checked before calling `WhatsAppProvider.sendMessage()`.
3. **Strict Provider Separation:** `MetaCloudProvider` (official commercial default) and optional local unofficial automation (`UnofficialDesktopProvider`) implement a shared `WhatsAppProvider` interface in separate packages. **DOM-based WhatsApp Web automation (`engine/content.js`) MUST NOT be migrated into Cloudflare Workers.**
4. **Compliance & Responsible Messaging:** All commercial campaign workflows require explicit `consent_records` verification and automated `STOP`/opt-out honoring. The architecture does **not** include ban-evasion or unsolicited bulk outreach features.

---

## Phase 1A Implementation Decisions & Auth Assessment (2026-11-26)

### Implemented Monorepo Layout
- `packages/shared` (`@wacrm/shared`): Zero-dependency pure TypeScript business logic (no Electron, no DOM globals, no WhatsApp selectors).
- `packages/db` (`@wacrm/db`): Drizzle ORM (`drizzle-orm/d1`) + `migrations/0001_phase1a_foundation.sql` containing `users`, `organizations`, `organization_members`, and `sessions`. Including `organizations` in Phase 1A avoids a destructive Phase 7 tenant migration.
- `apps/api` (`@wacrm/api`): Hono Worker app using `createApp()` factory for unit testing without provisioning live Cloudflare resources.
- Existing Electron files (`main.js`, `index.html`, `ui/`, `engine/`) remain untouched in root, except hygiene fixes in [ui/dashboard.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js) (CSV formula neutralization + `escapeHtml(c.id)`).

### Authentication Design Evaluation (Phase 1A)
1. **Workers WebCrypto Compatibility:** Cloudflare Workers `crypto.subtle` enforces a hard `100,000` iteration cap on `PBKDF2`. `packages/db/src/crypto.ts` enforces `PBKDF2_MAX_WORKERS_ITERATIONS = 100_000` and constant-time digest comparison, and hashes opaque session tokens with SHA-256 (`token_hash` only stored in `sessions`).
2. **CPU Budget Caveat:** While BoringSSL-backed `PBKDF2` is significantly faster than pure-JS hashing, live Worker isolate CPU time (`10 ms` Free-Tier limit) must still be benchmarked during Phase 1B/2 before enabling password logins at scale; OAuth2 (Google/GitHub) or magic-link flows remain viable lower-CPU alternatives.
3. **Email Verification & Password Reset Blocker:** Both require single-use expiring `verification_tokens` (hashed via SHA-256) **and** a chosen transactional email delivery provider. No email provider was invented or wired in Phase 1A.
4. **No Demo Auth:** Protected routes (`GET /api/v1/orgs/current`) strictly enforce Bearer session lookup + `organization_members` membership (`401`/`403`).

---

## Phase 1B Auth & Runtime Findings (2026-11-26)
- **Added Auth Tables (`0002_phase1b_auth_foundation.sql`):** `verification_tokens` and `auth_rate_limits` in `packages/db`.
- **PBKDF2 Gate Decision:** Local Node.js (`v26.13.1`) benchmark measured `40.6 ms` mean CPU (`31–47 ms`) for `100,000`-iteration `PBKDF2-SHA256`, above Workers Free `10 ms` CPU cap. Recommend **OAuth2 (Google/GitHub PKCE) + HMAC-SHA256 Magic Links** as primary `$0` Free-tier auth, keeping `PASSWORD_AUTH_ENABLED=false` on Free tier until edge benchmarked or upgraded to Workers Paid.
- **pnpm v12 Build Policy:** Configured `allowBuilds: { electron: true }` in `pnpm-workspace.yaml` (preserving Electron `v45.5.0` desktop compatibility).
