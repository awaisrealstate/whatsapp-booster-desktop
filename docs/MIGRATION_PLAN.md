# Migration Plan — Desktop Automator to Hybrid Cloud SaaS (Phase 0)

**Audit Date:** 2026-11-26  
**Status:** **PROPOSAL ONLY** — No files modified or removed during Phase 0.  
**Core Constraint:** Do **not** migrate existing DOM-based WhatsApp Web automation (`engine/content.js`) into Cloudflare Workers.

---

## 1. Retention, Refactoring & Replacement Matrix

| Existing Module | Decision | Target Destination & Justification |
| :--- | :--- | :--- |
| [ui/lib/csv-parser.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/lib/csv-parser.js) (`normalizePhone`, `parseCSVText`, column detection, `parseManualInput`) | **Retain & Extract** | Move into `packages/shared` as TypeScript modules with full unit tests. Reuse across web importer and backend validation. |
| [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js) (`mergeContactsPreserveProgress`, `formatMessageText`) | **Retain Logic & Refactor** | Extract pure merge/template logic into `packages/shared`; enforce Spintax bounds and map variables cleanly to Meta Cloud API template parameters. |
| [ui/dashboard.html](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.html) & [ui/dashboard.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js) | **Gradual Refactor** | Keep visual workflow/UX familiarity while replacing 1s `chrome.runtime` polling with REST + adaptive polling/SSE against `wacrm-api`, and adding Inbox, Contacts, AI Bot, and Auth views. |
| [main.js](file:///d:/Whatsapp%20Booster%20Desktop/main.js) & [index.html](file:///d:/Whatsapp%20Booster%20Desktop/index.html) | **Refactor & Harden** | Retain as the optional Electron desktop client (`apps/desktop`) with tray/notifications, but disable `nodeIntegration`, enable `contextIsolation: true` & `webSecurity: true`, and validate `postMessage` origins. |
| [engine/preload.js](file:///d:/Whatsapp%20Booster%20Desktop/engine/preload.js) & [engine/content.js](file:///d:/Whatsapp%20Booster%20Desktop/engine/content.js) | **Isolate Locally (Optional)** | Keep strictly inside the optional local Desktop Connector mode (`unofficial_local_desktop`), behind `WhatsAppProvider` abstraction and explicit user risk acknowledgement. **Never run in Cloudflare Workers.** |
| `ui/bridge.js` (`window.chrome` shim, `setTimeout`/`setInterval` orchestrator) | **Replace** | Replace browser-bound timers and `localStorage` state with durable D1 records, Cloudflare Cron Triggers, and Cloudflare Queues. |
| `ui/lib/xlsx.full.min.js` (`xlsx@0.18.5`) | **Replace** | Replace with a CVE-free MIT Excel library (`exceljs` / `read-excel-file`) executed client-side before sending JSON rows to the API. |
| `main.js` `campaign_state.json` | **Replace as Primary Store (Migrate Data)** | Replace with D1 as source of truth, providing a one-click import tool to preserve existing user contacts and `sentPhoneHistory`. |

---

## 2. Backward Compatibility & Data Preservation Strategy

1. **Non-Destructive Legacy Import:**
   - Existing users have local state in `./user_data/campaign_state.json` (plus `localStorage`).
   - Phase 2 will provide a **Legacy State Importer** (`POST /api/v1/import/legacy-state`) that reads `campaign_state.json` read-only, creates contacts in D1 (deduplicated per `organization_id, phone`), imports `sentPhoneHistory` as historical campaign records (preventing duplicate outreach), and preserves `googleSheetUrl` sync settings.
   - Local `campaign_state.json` is never deleted automatically; at most copied to a timestamped backup.
2. **Parallel Operation During Transition:**
   - Phases 1–4 do not break the existing Electron desktop app until the cloud API and web dashboard reach parity for contact management and campaign scheduling.
3. **Provider Abstraction Continuity:**
   - Both `MetaCloudProvider` (default commercial path) and `UnofficialDesktopProvider` (optional local path) share the same campaign/contact/template UI concepts, reducing user relearning.

---

## 3. Migration Risks & Mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| **Breaking existing local campaign progress during upgrade** | Duplicate sends or lost lead lists | Keep `user_data/` read-only during migration and write automated round-trip tests for the Legacy State Importer. |
| **WhatsApp Web DOM breakage in optional local mode** | Local connector fails to send | Isolate `engine/content.js` behind `WhatsAppProvider`, add dispatch timeouts so failures don't hang queues, and recommend Official Meta Cloud API as default. |
| **Workers Free `10 ms` CPU timeout during spreadsheet import or auth** | HTTP `1102` / `Exceeded CPU` errors | Parse `.xlsx`/CSV files in the browser, insert rows in chunked batches (`50–100` rows/request), and tune WebCrypto PBKDF2/token verification to fit comfortably under `10 ms`. |
| **Template syntax mismatch (`{name}` + Spintax vs Meta Templates)** | Meta Cloud API rejects outbound campaigns | Validate Meta templates separately (`{{1}}`, `{{2}}` positional/named variables) and restrict free-form Spintax to active 24h windows or explicit non-Meta channels. |
| **Unsolicited messaging / compliance exposure** | WABA suspension or legal violation | Enforce `consent_records` validation, automatic `STOP` opt-out suppression, and no ban-evasion tooling in cloud workflows. |

---

## Phase 1A Migration Progress & Blockers (2026-11-26)

### Completed in Phase 1A
- **Pure Logic Extracted:** `normalizePhoneNumber`, `validatePhoneNumber`, `validateContactInput`, `mergeContactsPreserveProgress`, `findNextPendingIndex`, `formatMessageText` (capped at `20` Spintax passes and `4096` chars), `parseCSVText`, and `sanitizeCsvCell` now live in `packages/shared` with **14 passing tests**.
- **Intentional Behavior Differences Documented:**
  - `validatePhoneNumber` enforces `8..15` digit E.164 bounds and rejects all-zero strings (legacy `normalizePhone` returned short/malformed strings unchanged).
  - `formatMessageText` caps Spintax at `20` passes and enforces a `4096`-character limit.
- **Dashboard Security Hygiene Applied:** [ui/dashboard.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js) now escapes `c.id` in table HTML and neutralizes `=`, `+`, `-`, `@`, `\t`, `\r` prefixes in CSV exports. Electron `webPreferences` in [main.js](file:///d:/Whatsapp%20Booster%20Desktop/main.js) remain untouched as required.

### Stopped Subtask — `xlsx@0.18.5` Replacement Blocker
- Verified that `read-excel-file` (and `exceljs`) do **not** support legacy binary `.xls` files (`FILE_NOT_SUPPORTED`), while [ui/dashboard.html](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.html#L221-L223) and [ui/dashboard.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js#L566) explicitly accept `.xls` and run without a module bundler.
- Per Phase 1A rules, replacement of `ui/lib/xlsx.full.min.js` was halted so existing imports do not break. Recommended Phase 2 resolution: deprecate `.xls` (prompting users to save as `.xlsx` or `.csv`) and adopt `read-excel-file` in the bundled web app.

### Dependencies & Verification
- Installed via `pnpm@12.23.0`: `typescript@5.9.3`, `drizzle-orm@0.41.0`, `hono@4.7.5`, `zod@3.25.76`, `@cloudflare/workers-types@4.20250321.0`.
- Verified: `pnpm.cmd -r typecheck` passed; `pnpm.cmd -r test` passed **26/26 tests** (`packages/shared`: 14, `packages/db`: 5, `apps/api`: 7).
