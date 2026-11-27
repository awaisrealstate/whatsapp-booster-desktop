# Security Audit — WhatsApp Booster Desktop (Phase 0)

**Audit Date:** 2026-11-26  
**Scope:** Security posture of the existing Electron desktop application and security architecture requirements for the multi-tenant Cloudflare SaaS transition.

---

## 1. Electron Security Configuration Findings (Verified Facts)

### [CRITICAL-1] `nodeIntegration: true`, `contextIsolation: false`, and `webSecurity: false`
- **Location:** [main.js](file:///d:/Whatsapp%20Booster%20Desktop/main.js#L123-L128)
- **Observed Code:**
  ```js
  webPreferences: {
    nodeIntegration: true,
    contextIsolation: false,
    webviewTag: true,
    webSecurity: false
  }
  ```
- **Risk:** Any script executing in `mainWindow` (`index.html`) has full Node.js access (`fs`, `child_process`, OS environment). Disabling `webSecurity` disables Same-Origin Policy, mixed-content protections, and CORS checks across the main shell.
- **Note on `<webview>`:** `<webview id="wa-webview">` does not inherit `nodeIntegration: true` by default, **however** its preload script ([engine/preload.js](file:///d:/Whatsapp%20Booster%20Desktop/engine/preload.js#L1-L21)) runs with Node `require('fs')`/`require('electron')` and injects `engine/content.js` directly into `web.whatsapp.com`'s page context without `contextIsolation` explicit configuration.

### [HIGH-1] Unvalidated `window.postMessage(..., '*')` Across All Boundaries
- **Locations:**
  - [index.html](file:///d:/Whatsapp%20Booster%20Desktop/index.html#L124-L210)
  - [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L276-L388), [#L660](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L660)
  - [engine/preload.js](file:///d:/Whatsapp%20Booster%20Desktop/engine/preload.js#L56-L69)
  - [engine/content.js](file:///d:/Whatsapp%20Booster%20Desktop/engine/content.js#L732-L755)
- **Risk:** None of the `window.addEventListener('message', ...)` handlers validate `event.origin` or `event.source`. Inside `index.html`, any child frame message can invoke `HOST_SAVE_STATE`, `HOST_SET_APP_SETTINGS` (including toggling Windows login autostart), or `DESKTOP_EXECUTE_DISPATCH`. Inside `web.whatsapp.com`, `preload.js` trusts any `WACRM_DESKTOP_RESULT` message posted to `window`.

### [HIGH-2] Known CVEs in Vendored SheetJS `0.18.5`
- **Location:** [ui/lib/xlsx.full.min.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/lib/xlsx.full.min.js) (`version="0.18.5"`)
- **Risk:** SheetJS `0.18.5` (last legacy npm release) has known Prototype Pollution (`CVE-2023-30533`) and ReDoS (`CVE-2024-22363`) vulnerabilities when parsing untrusted `.xlsx` files. Combined with `nodeIntegration: true` in the host shell, malicious spreadsheet files represent an escalation hazard.

### [HIGH-3] CSV Formula Injection & Unescaped ID Interpolation
- **Locations:**
  - [ui/dashboard.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js#L679-L685) (`btn-export-csv`): Exports `c.name`, `company`, and `c.errorMessage` wrapped in quotes without neutralizing leading `=`, `+`, `-`, `@`, `\t`, or `\r` characters (Excel DDE/formula injection).
  - [ui/dashboard.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js#L335): Interpolates `${c.id || idx + 1}` without `escapeHtml()`, unlike `c.name`, `c.phone`, and `company`.

### [MEDIUM-1] Plaintext Credential & PII Storage
- **Locations:** [main.js](file:///d:/Whatsapp%20Booster%20Desktop/main.js#L6-L13), [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L174-L202)
- **Risk:** All contact names, phone numbers, companies, and message templates are stored unencrypted in both `user_data/campaign_state.json` and `localStorage` (`wacrm_desktop_state`). WhatsApp Web session cookies/IndexedDB reside unencrypted in `./user_data/Partitions/whatsapp_booster_session/`.

### [MEDIUM-2] Global `User-Agent` Rewrite Across All Requests
- **Location:** [main.js](file:///d:/Whatsapp%20Booster%20Desktop/main.js#L192-L195)
- **Risk:** `session.defaultSession.webRequest.onBeforeSendHeaders` alters `User-Agent` for every outbound HTTP request from the app instead of scoping `{ urls: ['*://*.whatsapp.com/*'] }`.

### [MEDIUM-3] SSRF Risk When Moving Spreadsheet Sync to Cloud
- **Location:** [ui/lib/csv-parser.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/lib/csv-parser.js#L310-L382)
- **Risk:** `fetchLiveSpreadsheet()` currently runs client-side and accepts arbitrary URLs (`fetch(trimmed)`). Moving this logic unmodified into a Cloudflare Worker creates a Server-Side Request Forgery (SSRF) vulnerability.

### [LOW-1] Unbounded Spintax Loop Risk
- **Location:** [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L143-L152)
- **Risk:** Resetting `regex.lastIndex = 0` inside a `while` loop can expand nested/crafted `{a|b}` tokens excessively if message size and iteration count are not capped.

---

## 2. Target SaaS Security Requirements (API, Multi-Tenancy, Privacy)

1. **Authentication & Session Security:**
   - Use strong password hashing (`PBKDF2-SHA256` tuned for Workers `10ms` CPU or external OAuth2 / passwordless magic links) and `HttpOnly`, `Secure`, `SameSite=Lax` session cookies (plus short-lived scoped tokens for the Desktop client).
2. **Organization Isolation (Tenant Boundary):**
   - Every tenant resource in D1 must include `organization_id`, and every query/mutation must resolve `organization_id` from the authenticated session + `organization_members` RBAC check—never trusting a client-supplied `organization_id` without membership verification.
3. **Secrets & Token Encryption:**
   - Platform secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, `META_APP_SECRET`) stored via `wrangler secret put` (never committed to Git).
   - Tenant Meta Cloud API access tokens and optional bridge secrets encrypted at rest in D1 using **AES-256-GCM** via WebCrypto.
4. **API & Webhook Security:**
   - Verify all Meta Cloud API webhook `POST` payloads using `X-Hub-Signature-256` (HMAC-SHA256 with constant-time comparison) before enqueueing.
   - Enforce per-IP and per-organization rate limits on auth, webhook, campaign launch, and Workers AI endpoints.
   - Lock down spreadsheet URL fetching in Workers to `https://` allowlisted hosts (`docs.google.com`) with response size caps and timeouts.
5. **Data Privacy & Compliance:**
   - Track explicit opt-in and opt-out (`consent_records`), automatically suppress opted-out (`STOP`) contacts from outbound campaigns, provide data export/deletion endpoints per organization, and maintain `audit_logs` for sensitive actions (channel linking, credential rotation, campaign launch, member role changes).

---

## 3. Prioritized Remediation Roadmap

| Priority | Action | Target Phase |
| :--- | :--- | :--- |
| **P0 (Critical)** | Disable `nodeIntegration`, enable `contextIsolation: true` & `webSecurity: true`, introduce `contextBridge` preload for `mainWindow`. | Phase 1 |
| **P0 (Critical)** | Replace `xlsx@0.18.5` with a maintained MIT Excel/CSV parser (`exceljs` / `read-excel-file`) and sanitize CSV exports against formula injection. | Phase 1 |
| **P1 (High)** | Validate `event.origin`/`event.source` on all `postMessage` listeners; scope `User-Agent` header filter to `*.whatsapp.com`; escape `c.id` in table HTML. | Phase 1 |
| **P1 (High)** | Implement session auth, RBAC, `organization_id` query scoping, and AES-256-GCM encryption for stored WhatsApp tokens. | Phase 2 |
| **P1 (High)** | Implement HMAC-SHA256 `X-Hub-Signature-256` verification on Meta webhooks and SSRF allowlisting on Google Sheet sync. | Phase 3–4 |
| **P2 (Medium)** | Enforce `consent_records` checks, `STOP` auto-suppression, rate limiting, and `audit_logs`. | Phase 3–7 |
| **P3 (Low)** | Cap Spintax recursion/length and migrate Electron local token storage to Electron `safeStorage`. | Phase 1 / Phase 6 |

---

## Phase 1B Security Update (2026-11-26)
- **Resolved:** `template.ts` callback replacer (`$100`/`$&`/`$$`), `\n` and leading-whitespace CSV formula neutralization (`packages/shared/src/csv.ts` & `ui/dashboard.js`), `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` + `Access-Control-Expose-Headers: X-Request-Id` + recursive array/object log redaction (`apps/api`).
- **Auth Gate:** Local Node.js benchmark of `100,000`-iteration `PBKDF2-SHA256` measured `31–47 ms` CPU time (`40.31–43.71 ms` wall-clock). Because live Cloudflare Worker `10 ms` CPU compliance is unverified, password `register`/`login` are gated OFF (`503 PASSWORD_AUTH_GATED`) by default.
- **Still Open (Tracked):** `xlsx@0.18.5` (`ui/lib/xlsx.full.min.js`) retained temporarily for legacy `.xls` support; Electron `webPreferences` in `main.js` intentionally deferred to Phase 6.
