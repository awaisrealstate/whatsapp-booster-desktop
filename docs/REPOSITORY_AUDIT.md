# Repository Audit — WhatsApp Booster Desktop (Phase 0)

**Audited Repository:** `https://github.com/awaisrealstate/whatsapp-booster-desktop`  
**Local Commit:** `29a1ced` (`main`)  
**Audit Date:** 2026-11-26

---

## 1. Complete File and Folder Inventory

Top-level workspace contents observed on disk (`D:\Whatsapp Booster Desktop`):

```text
Whatsapp Booster Desktop/
├── .git/                         # Git repository (main @ 29a1ced)
├── .gitignore                    # Excludes node_modules/, user_data/, dist/, out/, *.log, .DS_Store, Thumbs.db (62 B)
├── Start-Whatsapp-Booster.bat    # Windows batch launcher for Electron (306 B)
├── package.json                  # App manifest & start script (291 B)
├── package-lock.json             # npm lockfile v3 (5,811 B, 175 lines)
├── main.js                       # Electron main process (5,786 B, 211 lines)
├── index.html                    # Host window shell & IPC/postMessage router (7,305 B, 214 lines)
├── desktop.css                   # Host window & split-view styles (3,275 B, 191 lines)
├── engine/
│   ├── preload.js                # <webview> preload script & DOM injector (2,382 B, 70 lines)
│   └── content.js                # In-page WhatsApp Web DOM automation engine (29,398 B, 758 lines)
├── icons/
│   ├── icon16.png                # 16x16 icon (627 B)
│   ├── icon48.png                # 48x48 tray icon (1,750 B)
│   └── icon128.png               # 128x128 app & notification icon (4,425 B)
├── ui/
│   ├── dashboard.html            # Control Center HTML + Settings modal (16,964 B, 370 lines)
│   ├── dashboard.css             # Dashboard dark theme CSS (16,469 B, 911 lines)
│   ├── dashboard.js              # UI controller & Chrome runtime caller (32,620 B, 747 lines)
│   ├── bridge.js                 # Chrome API shim + Campaign Orchestrator (34,686 B, 955 lines)
│   └── lib/
│       ├── csv-parser.js         # Phone normalizer, CSV/TSV, Google Sheets/OneDrive parser (13,894 B, 426 lines)
│       └── xlsx.full.min.js      # Vendored SheetJS 0.18.5 minified bundle (881,727 B, 22 lines)
└── node_modules/                 # Installed npm packages (electron@45.5.0 + transitive deps)
```

### Files / Artifacts Confirmed Absent
- No `user_data/` folder exists on disk yet (created at runtime by `main.js#L6-L9`).
- No `README.md`, `LICENSE` file, `.env*`, or `wrangler.*` configuration files.
- No automated test files (`*.test.js`, `*.spec.js`), linter configs, formatter configs, or TypeScript configs.
- No `.github/workflows/` CI/CD pipelines or `electron-builder` packaging configs.

### Inspection Scope & Uninspected Binary/Minified Artifacts
- **Inspected line-by-line:** `package.json`, `package-lock.json`, `Start-Whatsapp-Booster.bat`, `.gitignore`, `main.js`, `index.html`, `desktop.css`, `engine/preload.js`, `engine/content.js`, `ui/dashboard.html`, `ui/dashboard.css`, `ui/dashboard.js`, `ui/bridge.js`, `ui/lib/csv-parser.js`.
- **Partially inspected:** `ui/lib/xlsx.full.min.js` (881 KB minified single-line blocks; inspected header comments, license notice, and `XLSX.version` = `0.18.5`, not all minified code internals).
- **Not inspected:** Binary PNG pixel data in `icons/*.png` and compiled binaries/source inside `node_modules/` (package names, versions, and licenses were inspected via `package-lock.json` and `node_modules/electron` directory listing).
- **Runtime execution:** The Electron application was **not executed** during Phase 0; all behavior notes reflect static source inspection.

---

## 2. Purpose of Important Files

| File | Core Responsibility |
| :--- | :--- |
| [main.js](file:///d:/Whatsapp%20Booster%20Desktop/main.js) | Electron entry point: portable `user_data/` path, atomic JSON read/write, single-instance lock, tray icon, minimize-to-tray, Windows autostart, OS notifications, Chrome 126 `User-Agent` header injection. |
| [index.html](file:///d:/Whatsapp%20Booster%20Desktop/index.html) | Shell UI with 3 view tabs (`dashboard`, `whatsapp`, `split`), connection pill, `4000ms` connection check interval, and bidirectional `postMessage` ↔ `ipcRenderer`/`webview` bridge. |
| [ui/bridge.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/bridge.js) | Emulates `window.chrome.storage.local` and `window.chrome.runtime` for `dashboard.js`, manages `Orchestrator` state/timers, executes `mergeContactsPreserveProgress`, syncs Google Sheets, and saves state to `localStorage` + Electron IPC. |
| [ui/dashboard.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/dashboard.js) | Renders KPIs, banners, message template preview, audience table (search/filter/CSV export), and settings modal; polls `bridge.js` every `1000ms`. |
| [ui/lib/csv-parser.js](file:///d:/Whatsapp%20Booster%20Desktop/ui/lib/csv-parser.js) | Implements `window.WACRMParser`: Pakistani/international phone normalization, CSV/TSV parsing, column detection (English & Urdu), SheetJS Excel wrapper, Google Sheets/OneDrive link fetching, and paste parsing. |
| [engine/preload.js](file:///d:/Whatsapp%20Booster%20Desktop/engine/preload.js) | Injects `engine/content.js` into `web.whatsapp.com`, checks WhatsApp DOM state, and forwards single-message dispatch commands/results across `ipcRenderer` and `window.postMessage`. |
| [engine/content.js](file:///d:/Whatsapp%20Booster%20Desktop/engine/content.js) | Automates WhatsApp Web DOM inside the page: deduplication locks, "New chat" drawer search, React/Lexical input simulation, multi-layer result selection, header verification, and single-send confirmation. |

---

## 3. Existing Dependencies & Licenses

| Package / Asset | Version | Scope | License | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `whatsapp-booster-desktop` | `1.0.0` | Root | `ISC` (declared in `package.json`) | Missing standalone `LICENSE` file. |
| `electron` | `^45.5.0` (`45.5.0` locked) | `devDependencies` | `MIT` | Only npm dependency declared in `package.json`. |
| `xlsx.full.min.js` (SheetJS CE) | `0.18.5` | Vendored in `ui/lib/` | `Apache-2.0` (legacy npm CE) | Known CVEs (`CVE-2023-30533` Prototype Pollution, `CVE-2024-22363` ReDoS). |
| Transitive `electron` deps | Various (`package-lock.json`) | `dev` | `MIT`, `ISC`, `Apache-2.0`, `BlueOak-1.0.0` | All permissive OSS licenses. |

---

## 4. Code Quality Observations

### Positive Engineering Practices Observed
- **Atomic File Writes (`main.js#L30-L40`):** Writes to `.tmp` before `fs.renameSync` to avoid partial JSON writes.
- **Crash Recovery (`ui/bridge.js#L333-L337`):** Reverts contacts left in `'sending'` back to `'pending'` on startup hydration.
- **XSS Mitigation in Audience Table (`ui/dashboard.js#L348-L352`):** `escapeHtml()` is used on contact names, phones, companies, and timestamps.
- **Pure Function Exports (`ui/bridge.js#L157-L164`):** `normalizePhoneNumber`, `mergeContactsPreserveProgress`, `findNextPendingIndex`, and `formatMessageText` are conditionally exported via `module.exports` for Node testing.
- **Chat Isolation Guard (`engine/content.js#L641-L653`):** Refuses to send if `#main header` still matches the previous chat or lacks a verified composer.

### Code Quality & Reliability Deficiencies
- **High-Frequency UI Polling (`ui/dashboard.js#L739-L742`):** Calls `syncWithBackground()` and `checkWhatsAppConnection()` every `1000ms`, re-rendering the entire `<tbody>` HTML string (`renderAudienceTable()`) every second regardless of whether state changed.
- **Logic Duplication:**
  - `normalizePhone` (`ui/lib/csv-parser.js#L24`) vs `normalizePhoneNumber` fallback (`ui/bridge.js#L15`).
  - Template variable + Spintax rendering duplicated between `ui/bridge.js#L125` and `ui/dashboard.js#L265`.
  - WhatsApp connection DOM selectors duplicated between `engine/preload.js#L25` and `engine/content.js#L102` (`WACRM_DESKTOP_CHECK_CONN` at `content.js#L735` is dead/unused).
- **Hung Dispatch Risk (`ui/bridge.js#L650-L670`):** `Orchestrator.isDispatching = true` has no timeout; if `waWebview` reloads or crashes before replying with `HOST_DISPATCH_RESULT`, dispatching stalls until app restart.
- **Inaccurate Batch Counter (`ui/dashboard.js#L86`):** `batchNum = Math.floor(processedCount / dailyLimit) + 1` counts `failed` contacts in `processedCount`, whereas `batchSentCount` only increments on `sent`.
- **Blocking Native Dialogs:** Extensive use of `alert()` and `confirm()` in `ui/dashboard.js` blocks the renderer thread.

---

## 5. Technical Debt Summary

1. **Extension-to-Desktop Adapter Debt:** `ui/bridge.js` exists largely to emulate `chrome.runtime` and `chrome.storage` for `ui/dashboard.js`.
2. **Monolithic State Serialization:** All contacts, `sentPhoneHistory`, and settings are stored in a single JSON object re-written in full on every state transition (`Orchestrator.save()`).
3. **Brittle DOM Coupling:** `engine/content.js` relies on dozens of undocumented WhatsApp Web selectors (`data-testid`, `data-tab`, `data-icon`, Urdu/English `aria-label` strings) that require ongoing maintenance whenever Meta updates `web.whatsapp.com`.
4. **Zero Automated Verification:** No unit, integration, or E2E tests exist despite conditional `module.exports` in `ui/bridge.js`.
5. **Hardcoded Branding & Language Mix:** UI and tray notifications mix English, Roman Urdu, and Urdu script inline in HTML/JS rather than using an i18n dictionary.
6. **Electron Packaging Gap:** `main.js#L56` passes `args: [path.resolve(__dirname)]` to `app.setLoginItemSettings`, which assumes running via `electron .` rather than a packaged `.exe`.
