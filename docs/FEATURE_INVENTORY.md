# Feature Inventory — WhatsApp Booster Desktop (Phase 0)

**Audit Date:** 2026-11-26  
**Strict Verification Rule:** During Phase 0, the repository was audited via static source inspection only; the Electron app was **not launched or run against WhatsApp Web**. Therefore, no feature is claimed as runtime-verified—every existing capability below is categorized by **source-code completeness** and explicitly marked as requiring runtime testing.

---

## 1. Existing Implemented Features (Observed in Code — Require Runtime Verification)

| Feature | Implementation Evidence | Verification Status |
| :--- | :--- | :--- |
| **3-Tab Desktop Viewport (Dashboard / WhatsApp / Split)** | [index.html](file:///d:/Whatsapp%20Booster%20Desktop/index.html#L23-L96), [desktop.css](file:///d:/Whatsapp%20Booster%20Desktop/desktop.css#L179-L191) | Implemented in code; requires runtime test. |
| **Persistent WhatsApp Web `<webview>` Partition** | [index.html](file:///d:/Whatsapp%20Booster%20Desktop/index.html#L53-L61) (`persist:whatsapp_booster_session`) | Implemented in code; requires runtime test. |
| **System Tray, Minimize-to-Tray & Single-Instance Lock** | [main.js](file:///d:/Whatsapp%20Booster%20Desktop/main.js#L64-L151) | Implemented in code; requires runtime test on Windows. |
| **Atomic Local JSON & `localStorage` Dual Persistence** | [main.js](file:///d:/Whatsapp%20Booster%20Desktop/main.js#L30-L40), [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L266-L380) | Implemented in code; requires runtime test. |
| **CSV / TSV / Semicolon File & Paste Parsing** | [ui/lib/csv-parser.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/lib/csv-parser.js#L69-L280), [#L389-L417](file:///d:/Whatsapp%20Booster%20Desktop/ui/lib/csv-parser.js#L389-L417) | Implemented in code; requires unit & runtime test. |
| **Excel (`.xlsx`/`.xls`) Upload Parsing** | [ui/lib/csv-parser.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/lib/csv-parser.js#L282-L296), `ui/lib/xlsx.full.min.js` | Implemented in code (`xlsx@0.18.5` CVE risk); requires test. |
| **Pakistani & Default Country Code Phone Normalization** | [ui/lib/csv-parser.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/lib/csv-parser.js#L24-L67), [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L15-L39) | Implemented in code; requires unit tests. |
| **Smart List Merge (`sentPhoneHistory` preservation)** | [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L47-L117) | Implemented in code; requires unit tests. |
| **Template Variables (`{name}`, `{firstname}`, `{phone}`, `{customVars}`) & Spintax** | [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L125-L154), [ui/dashboard.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js#L265-L296) | Implemented in code; requires edge-case tests. |
| **Audience Search, Status Filters, Sample Leads & CSV Export** | [ui/dashboard.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js#L17-L53), [#L299-L346](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js#L299-L346), [#L642-L692](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js#L642-L692) | Implemented in code; requires runtime test. |
| **Campaign Start / Pause / Resume / Stop / Reset Sheet** | [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L537-L615), [#L856-L889](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L856-L889) | Implemented in code; requires runtime test. |
| **Configurable Pacing, Batch Limit, Cooldown & Offline Wait** | [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L617-L755) | Implemented in code; requires runtime test. |

---

## 2. Partially Implemented or Fragile Features

| Feature | What Exists in Code | Why Partial / Fragile |
| :--- | :--- | :--- |
| **Google Sheets & OneDrive Live Sync** | [ui/lib/csv-parser.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/lib/csv-parser.js#L298-L382), [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L462-L491) | Only works for publicly shared ("Anyone with the link") Google Sheets; OneDrive/SharePoint frequently blocks unauthenticated downloads (handled via fallback error message telling user to copy-paste). |
| **WhatsApp Web DOM Dispatch (`v11.0`)** | [engine/content.js](file:///d:/Whatsapp%20Booster%20Desktop/engine/content.js#L99-L707) | Sophisticated multi-layer selectors and header guard, but tightly coupled to live `web.whatsapp.com` DOM structure which Meta can change at any time. No dispatch timeout in `bridge.js` if webview stalls. |
| **Windows Boot Autostart** | [main.js](file:///d:/Whatsapp%20Booster%20Desktop/main.js#L50-L62) | Passes `args: [path.resolve(__dirname)]`, which works only when launched from source via `electron .`, not when packaged as a standalone installer. |
| **WhatsApp Connection Status Check** | [engine/preload.js](file:///d:/Whatsapp%20Booster%20Desktop/engine/preload.js#L24-L52) & [engine/content.js](file:///d:/Whatsapp%20Booster%20Desktop/engine/content.js#L101-L132) | Duplicated logic across two files; `WACRM_DESKTOP_CHECK_CONN` in `content.js#L735` is unused. |
| **Keepalive Port (`wacrm_keepalive`)** | [ui/dashboard.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js#L14), [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js#L943-L950) | No-op shim left over from Chrome Extension Manifest V3 service-worker keepalive. |

---

## 3. Missing Features (Required for Target SaaS Vision)

1. **Official Meta WhatsApp Cloud API Integration:** No Graph API sender, no template approval sync, no `X-Hub-Signature-256` webhook receiver, and no 24-hour customer service window tracking.
2. **Two-Way WhatsApp CRM & Shared Inbox:** No inbound message ingestion, conversation threads, delivery/read receipt tracking (`sent`, `delivered`, `read`), agent assignment, or internal notes.
3. **AI Customer Support Bot:** No LLM integration (Workers AI), no knowledge base / FAQ retrieval, and no AI-to-human handoff rules.
4. **Cloud-Independent Scheduled Campaigns:** Campaigns cannot run when the user's laptop is off; no `scheduled_at` / timezone / recurrence scheduler in D1/Cron/Queues.
5. **Contact Segmentation, Tags & Consent Compliance:** No tag management, dynamic segments, or `consent_records` (opt-in proof / automated `STOP` opt-out enforcement).
6. **Multi-User Auth, Organizations & SaaS Controls:** No login, sessions, organizations, RBAC, tenant isolation, usage metering, or audit logs.
7. **Responsive Mobile/Tablet Web UI:** Current `dashboard.css` uses a fixed `460px 1fr` desktop grid (`.dashboard-grid`) without responsive breakpoints.
8. **Automated Test Suite & CI/CD:** Zero unit, integration, or E2E tests currently exist.

---

## 4. Features Requiring Immediate Testing (Phase 1 Entry Gate)

1. Unit tests for `normalizePhoneNumber`, `mergeContactsPreserveProgress`, `findNextPendingIndex`, `formatMessageText`, and `parseCSVText`.
2. Boundary tests for Spintax edge cases (nested braces, missing closing brace, empty options) and malformed CSV/XLSX inputs.
3. Smoke test of Electron startup (`electron .`), `user_data/campaign_state.json` round-trip persistence, and tray/close behavior on Windows.
4. Live verification of `engine/content.js` selectors against current `https://web.whatsapp.com` (strictly in a personal/test sandbox account) before wrapping it as an optional legacy connector.
