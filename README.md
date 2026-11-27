# WhatsApp Booster Pro (Complete Guide in Roman English)

Ye ek dual-mode **WhatsApp Marketing, CRM aur AI Customer Support Platform** hai jisme 2 modes shamil hain:

1. **Desktop Edition (`Electron v45.5.0`):** Windows PC ke liye autonomous local campaign software jo WhatsApp Web session save rakhta hai aur background mein bhi kaam karta hai.
2. **Cloud SaaS Edition (`Cloudflare Workers + D1 + Queues + Workers AI + Pages`):** Online multi-tenant CRM jo **Official Meta WhatsApp Cloud API** par chalta hai — jisme scheduled cloud campaigns, English/Urdu FTS5 AI customer support bot, Google/GitHub OAuth2 PKCE login, team roles (RBAC), aur SaaS plan limits shamil hain.

---

## Index (Is File Mein Kya Hai)

- [Saare Features (Desktop + Cloud)](#saare-features)
  - [1. Desktop Edition ke Features](#1-desktop-edition-ke-features)
  - [2. Cloud SaaS Platform ke Features (15 Modules)](#2-cloud-saas-platform-ke-features-15-modules)
  - [3. Security aur Compliance Controls](#3-security-aur-compliance-controls)
- [Desktop Edition Kaise Use Karein](#desktop-edition-kaise-use-karein)
- [Cloud SaaS Platform Kaise Use Karein (Local aur Online)](#cloud-saas-platform-kaise-use-karein)
- [SaaS Plan Limits](#saas-plan-limits)
- [Project Folder Structure](#project-folder-structure)
- [Testing aur Check Commands](#testing-aur-check-commands)
- [Baqi Zaroori Guides](#baqi-zaroori-guides)

---

## Saare Features

### 1. Desktop Edition ke Features

- **Ek Bar WhatsApp QR Link Karein:** WhatsApp session `user_data/` folder (`persist:whatsapp_booster_session`) mein save rehta hai, to bar-bar QR code scan nahi karna parta jab tak aap khud logout na karein.
- **Audience Data Hub (`Google Sheets aur Excel`):**
  - Apne PC se `.xlsx`, `.xls`, `.csv`, ya `.txt` files drag & drop ya browse karke upload karein.
  - Public Google Sheet ya OneDrive/Microsoft 365 link paste karke **Sync Link** dabayein — sheet automatic sync bhi ho sakti hai.
  - **Quick Paste from Excel (`Ctrl+V`):** Excel ya Excel Online se rows copy karke seedha paste karein aur import kar lein.
  - **Load 35 Sample Leads:** Testing ke liye demo leads ek click mein load ho jati hain.
  - **Phone Normalization & Smart Merge:** Numbers khud standard format (`+92` ya apke chosen country code) mein convert hote hain. Agar aap nayi sheet sync karein to pehle se `sent` ho chuke numbers dobara message nahi hotay — sirf naye pending numbers par message jata hai.
- **Live Message Template & Spintax (`Change Anytime`):**
  - Dynamic variables use karein: `{name}`, `{firstname}`, `{phone}`, `{company}`, Urdu `{نام}`, ya apni sheet ke custom columns.
  - Spintax variations (maslan `{Hello|Hi|Greetings}`) har contact ke liye message alag banata hai (max `20` passes tak safe evaluation).
  - Neeche live preview nazar aata hai. Aap campaign pause karke ya messages ke darmiyan kisi bhi waqt template edit kar sakte hain.
- **Autonomous Anti-Ban Campaign Controller:**
  - **Daily Batch Limit** set karein (default `30` messages per batch).
  - **Dynamic Random Gap** (`60s - 120s` default) aur **Typing Delay Before Send** (`2500 ms` default) taake sending natural lage.
  - **Variable Cooldown** (`24h - 28h` default) aur zarurat parne par manual override option.
  - **Auto-Resume After Cooldown** & **Auto-Resume On Startup:** Agar cooldown poora ho ya PC/app restart ho to jahan kaam ruka tha wahin se khud aage chalta hai.
  - **Auto-Update Google Sheet** (default har `5` minute) aur **Auto-Dispatch New Additions:** Jab sheet mein naye numbers add hon to software unhe khud utha kar bhej sakta hai.
  - **Background System Tray & Windows Startup:** Window close karne par app band nahi hoti balki tray mein chalti rehti hai; Windows start hone par auto-launch ka option bhi hai.
- **Audience Directory, Reports & Cloud Migration:**
  - Search bar aur filter tabs (`All`, `Sent`, `Pending`, `Failed`), progress bar, aur live activity logs.
  - **Reset & Retry Entire Sheet** (`#btn-retry-failed`) poori sheet dobara queue karne ke liye.
  - **Export Delivery Report** (CSV formula-safe export) aur **Export State JSON** (`#btn-export-legacy-state`) jisse aap apna local `campaign_state.json` data Cloud CRM mein migrate kar sakte hain.

---

### 2. Cloud SaaS Platform ke Features (15 Modules)

Cloud Web Dashboard ([apps/web/index.html](file:///d:/Whatsapp%20Booster%20Desktop/apps/web/index.html)) Cloudflare API ([apps/api](file:///d:/Whatsapp%20Booster%20Desktop/apps/api)) aur Worker Engine ([apps/worker](file:///d:/Whatsapp%20Booster%20Desktop/apps/worker)) ke saath chalta hai:

| # | Module | Ismein Kya Kaam Hota Hai |
| :--- | :--- | :--- |
| **1** | **Dashboard Overview** | Total D1 contacts, cloud campaigns, mahine ke outbound messages, aaj ke AI replies, connected provider status, aur recent audit logs dekhein. |
| **2** | **Contacts** | Contacts add/edit/delete karein, lead stage (`lead`, `contacted`, `qualified`, `won`, `lost`) set karein, safe Cloud Import (`.csv`, `.tsv`, `.txt`, `.xlsx`) chalayein, ya Desktop app ki exported JSON file dry-run aur import karein. |
| **3** | **Contact Lists** | Alag-alag audience lists banayein taake campaigns sirf target group ko jayein. |
| **4** | **Tags & Consent** | Color tags lagayein aur **Consent & STOP Suppression** check karein (`Check Eligibility`, `Record Opt-In`, `Record STOP`). Agar contact delete bhi ho jaye to `STOP` block record hamesha mehfooz rehta hai. |
| **5** | **Conversations Inbox** | Two-way WhatsApp inbox: customer ke incoming messages dekhein, 24-hour reply window check karein, **Transfer to Human** button se human agent ko handoff karein, ya **Draft/Send AI Reply** test karein. |
| **6** | **WhatsApp Connection** | Apna **Official Meta WhatsApp Cloud API** account connect karein (`metaWabaId`, `metaPhoneNumberId`, access token, app secret, webhook verify token). Keys AES-256-GCM se encrypt hoti hain. |
| **7** | **Message Templates** | Meta ke approved templates (`UTILITY`, `MARKETING`, `AUTHENTICATION`) aur 24h-window `CUSTOM_TEXT` templates banayein aur sync karein. |
| **8** | **Campaign Management** | Turant (`Immediate`) ya scheduled (`Cron */2 * * * *`) cloud campaigns chalayein Cloudflare Queues (`max_batch_size: 10`) ke zariye — pause/resume/cancel, auto retry (`10s`, `30s`, `90s`), aur duplicate-send protection ke saath. |
| **9** | **Campaign Reports** | Har number ki report (`WAMID`, status, attempts, errors) dekhein aur **Safe CSV Export** download karein. |
| **10** | **AI Customer Support** | Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct-fast`) par chalne wala AI bot ON/OFF karein, English/Urdu instructions likhein, daily reply limit set karein, aur human handoff keywords set karein (`agent`, `human`, `manager`, `مدد`, `نمائندہ`, `شکایت`, waghera). |
| **11** | **Knowledge Base** | Apni company ki FAQs, rates, ya policies (`en` ya `ur`) add karein. Ye **D1 SQLite FTS5** (`knowledge_fts` triggers) se auto-index hoti hain. Agar jawab Knowledge Base mein na ho to AI khud tukka nahi lagata balki human agent ko transfer karta hai. |
| **12** | **Team Members** | Apni team ko email se invite karein, role select karein, invite token share karein, ya team member remove karein. |
| **13** | **Roles & Permissions** | 5 roles ki mukammal permissions: **Owner**, **Admin**, **Manager**, **Agent**, aur **Viewer**. |
| **14** | **Usage & Subscription** | Har organization ka real usage meter (`free`, `pro`, `business`) contacts, campaigns, outbound messages, AI replies, knowledge docs, aur team members ke hisab se. |
| **15** | **Organization Settings** | Workspace naam, default country code, timezone update karein, multiple organizations banayein/switch karein, aur security `audit_logs` dekhein. |

---

### 3. Security aur Compliance Controls

- **Hardened Electron App:** `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, aur `contextBridge` API ([preload-main.js](file:///d:/Whatsapp%20Booster%20Desktop/preload-main.js)). IPC sender verification (`isTrustedMainSender`), unknown popups/links block, `postMessage` source verification, aur Google Sheets URL filter (`https://docs.google.com/spreadsheets/*` only).
- **Encrypted Tokens:** Meta credentials `ENCRYPTION_KEY` ke sath AES-256-GCM mein encrypt hote hain; session tokens, verify tokens, aur team invites sirf SHA-256 hash ki shakal mein store hote hain.
- **Webhook Security & Rules:** Meta webhooks par raw-body HMAC-SHA256 `X-Hub-Signature-256` verify hota hai, `STOP` bolne wale customers auto-block hote hain, aur 24-hour customer care window se bahar free-form text block (`422 OUTSIDE_24H_WINDOW`) hota hai.
- **Safe File Parsing:** Cloud imports modern `.xlsx` ke liye `read-excel-file/universal` use karte hain aur purani `.xls` binary files ko block karte hain (`xlsx@0.18.5` cloud mein use nahi hota). CSV exports formula attacks (`=`, `+`, `-`, `@`, `\t`, `\r`, `\n`) ko neutralize karte hain.
- **OAuth2 PKCE Login:** Google aur GitHub OAuth2 S256 PKCE ke sath chalta hai (`PASSWORD_AUTH_ENABLED=false` default rakha gaya hai taake Cloudflare Free Tier ki `10 ms` CPU limit cross na ho).

---

## Desktop Edition Kaise Use Karein

### Step 1: Pehli Dafa Install Karein

Apne Windows PC par **Node.js (v20+)** aur **pnpm (`12.23.0`)** install honay chahiye. Phir project folder mein command chalayein:

```powershell
cd "d:\Whatsapp Booster Desktop"
pnpm.cmd install
```

### Step 2: Software Open Karein

Is file par double-click karein: **[Start-Whatsapp-Booster.bat](file:///d:/Whatsapp%20Booster%20Desktop/Start-Whatsapp-Booster.bat)**  
Ya PowerShell se chalayein:

```powershell
pnpm.cmd start
```

### Step 3: Campaign Chalane ka Tareeqa

1. **WhatsApp Connect Karein:** **Link WhatsApp Account** (ya **WhatsApp Link**) button dabayein aur right side par khulne wale WhatsApp tab mein apne mobile se QR code scan karein.
2. **Contacts Load Karein:**
   - Apni Excel/CSV file (`.xlsx`, `.xls`, `.csv`, `.txt`) drag & drop karein, **ya**
   - Excel se cells copy karke **Quick Paste from Excel (`Ctrl+V`)** mein paste karein, **ya**
   - Public Google Sheet ka link paste karke **Sync Link** dabayein.
3. **Message Likhein:** Template box mein apna paigham likhein, pills (`{name}`, `{firstname}`, `{company}`, `{Hello|Hi|Greetings}`) add karein aur neeche **Live Preview** check karein.
4. **Auto Settings Set Karein:** Top bar mein **Auto Settings** khol kar daily batch limit (default `30`), message gap (`60s–120s`), cooldown (`24h–28h`), sheet auto-sync timer, tray mode, aur Windows startup toggle set karein.
5. **Start Karein:** **Launch Daily Batch** dabayein. Aap kisi bhi waqt Pause/Stop kar sakte hain, template badal sakte hain, CSV delivery report download kar sakte hain, ya **Export State JSON** se apna data Cloud CRM mein le ja sakte hain.

> **Background Tip:** Window close karne par app minimize-to-tray hoti hai taake campaign chalti rahe. Mukammal band karne ke liye system tray icon par right-click karke **Quit Completely** click karein.

---

## Cloud SaaS Platform Kaise Use Karein

### Tareeqa A: Apne PC Par Local Test Chalayein

1. **Template files copy karein (real `.dev.vars` ya `wrangler.jsonc` kabhi Git par push na karein):**
   ```powershell
   Copy-Item apps/api/.dev.vars.example apps/api/.dev.vars
   Copy-Item apps/worker/.dev.vars.example apps/worker/.dev.vars
   Copy-Item apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc
   Copy-Item apps/worker/wrangler.example.jsonc apps/worker/wrangler.jsonc
   Copy-Item apps/web/wrangler.example.jsonc apps/web/wrangler.jsonc
   ```
   `apps/api/.dev.vars` aur `apps/worker/.dev.vars` mein `ENCRYPTION_KEY` (kam az kam 32 characters) aur chaho to `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` daal dein.

2. **Local D1 database ki 5 migrations apply karein:**
   ```powershell
   npx.cmd wrangler d1 migrations apply wacrm-db --config apps/api/wrangler.jsonc --local
   ```

3. **3 alag terminals mein API, Worker Engine aur Web Dashboard chalayein:**
   ```powershell
   # Terminal 1: API Worker (http://127.0.0.1:8787)
   npx.cmd wrangler dev apps/api/src/index.ts --config apps/api/wrangler.jsonc

   # Terminal 2: Background Queue & Cron Worker
   npx.cmd wrangler dev apps/worker/src/index.ts --config apps/worker/wrangler.jsonc

   # Terminal 3: Web Dashboard (http://127.0.0.1:8788)
   npx.cmd wrangler pages dev apps/web --port 8788
   ```

4. Browser mein `http://127.0.0.1:8788` kholein, `API URL` check karein (`http://127.0.0.1:8787`), aur **Google OAuth2** ya **GitHub OAuth2** se sign in karein.

### Tareeqa B: Live Cloudflare Server Par Setup & Use Karein

Live Cloudflare Free Tier (`$0`) setup karne ke liye detail guide **[CLOUDFLARE_MANUAL_SETUP.md](file:///d:/Whatsapp%20Booster%20Desktop/docs/CLOUDFLARE_MANUAL_SETUP.md)** aur **[PRODUCTION_DEPLOYMENT_GUIDE.md](file:///d:/Whatsapp%20Booster%20Desktop/docs/PRODUCTION_DEPLOYMENT_GUIDE.md)** follow karein. Deploy hone ke baad:

1. **Login aur Settings:** Google/GitHub se login karein aur **15. Organization Settings** mein workspace naam, country code (maslan `92`), aur timezone set karein.
2. **Meta WhatsApp Connect Karein:** **6. WhatsApp Connection** mein apna Meta WABA ID, Phone Number ID, System User Access Token, App Secret, aur Verify Token save karein. Phir Meta Developer Portal (**WhatsApp > Configuration > Webhook**) mein apna `/webhooks/meta` URL paste karke `messages` subscribe karein.
3. **Contacts & Lists Banayein:** **2. Contacts** se CSV/TSV/`.xlsx` ya Desktop ki exported JSON file upload karein aur **3. Contact Lists** / **4. Tags & Consent** mein manage karein.
4. **Templates & Campaigns Chalayein:** **7. Message Templates** aur **8. Campaign Management** se campaigns schedule ya launch karein aur **9. Campaign Reports** mein delivery status dekhein.
5. **AI Support On Karein:** **11. Knowledge Base** mein company FAQs (`en` ya `ur`) add karein, **10. AI Customer Support** ON karein, aur **5. Conversations Inbox** mein live customer replies aur human handoffs manage karein.
6. **Team & Quotas Manage Karein:** **12. Team Members** se teammates invite karein, **13. Roles & Permissions** check karein, aur **14. Usage & Subscription** mein daily/monthly limits dekhein.

---

## SaaS Plan Limits

Ye limits [packages/db/src/plans.ts](file:///d:/Whatsapp%20Booster%20Desktop/packages/db/src/plans.ts) mein configured hain:

| Plan | Reference Price | Max Contacts | Max Campaigns | Monthly Outbound Msgs | Daily AI Replies | Max Knowledge Docs | Max Team Members |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Free** (`free`) | \$0 / mo | 500 | 5 | 1,000 | 50 | 20 | 2 |
| **Pro** (`pro`) | \$29 / mo | 10,000 | 50 | 25,000 | 500 | 200 | 10 |
| **Business** (`business`) | \$99 / mo | 100,000 | 500 | 250,000 | 2,000 | 1,000 | 50 |

---

## Project Folder Structure

```text
.
├── main.js                       # Hardened Electron main process & IPC security
├── preload-main.js               # Safe contextBridge API desktop UI ke liye
├── index.html                    # Desktop app shell (Control Center + WhatsApp Webview)
├── Start-Whatsapp-Booster.bat    # Windows ek-click launcher
├── engine/                       # WhatsApp Web <webview> preload aur message dispatch
├── ui/                           # Desktop UI, CSV/Excel parser, bridge aur CSS
├── apps/
│   ├── api/                      # Cloudflare Worker REST API (wacrm-api)
│   ├── worker/                   # Background Queue & Cron Worker (wacrm-engine)
│   └── web/                      # 15-module SaaS Dashboard (wacrm-web)
├── packages/
│   ├── shared/                   # Phone normalization, templates, Spintax, CSV/.xlsx tools
│   ├── providers/                # MetaCloudProvider, HMAC webhook checks, STOP detection
│   └── db/                       # Drizzle schema, 0001–0005 migrations, AI FTS5, RBAC, SaaS
└── docs/                         # Setup guides, security audit, aur test reports
```

---

## Testing aur Check Commands

PowerShell mein `d:\Whatsapp Booster Desktop` se chalayein:

```powershell
# Saare workspace packages ka TypeScript check
pnpm.cmd -r typecheck

# Saare 60 unit & integration tests (6 packages)
pnpm.cmd -r test

# Cloudflare Worker production build dry-run check
npx.cmd wrangler deploy apps/api/src/index.ts --config apps/api/wrangler.example.jsonc --dry-run
npx.cmd wrangler deploy apps/worker/src/index.ts --config apps/worker/wrangler.example.jsonc --dry-run
```

---

## Baqi Zaroori Guides

- **[CLOUDFLARE_MANUAL_SETUP.md](file:///d:/Whatsapp%20Booster%20Desktop/docs/CLOUDFLARE_MANUAL_SETUP.md)** — Asaan step-by-step Cloudflare, D1, Queue, OAuth2 aur Meta setup guide.
- **[PRODUCTION_DEPLOYMENT_GUIDE.md](file:///d:/Whatsapp%20Booster%20Desktop/docs/PRODUCTION_DEPLOYMENT_GUIDE.md)** — Deployment sequence, secrets list aur Free-Tier rules.
- **[FINAL_PRODUCT_REPORT.md](file:///d:/Whatsapp%20Booster%20Desktop/docs/FINAL_PRODUCT_REPORT.md)** — Complete technical report aur pending credentials ki details.
- **[SECURITY_FINAL_AUDIT.md](file:///d:/Whatsapp%20Booster%20Desktop/docs/SECURITY_FINAL_AUDIT.md)** — Desktop aur Cloud security audit ki tafseel.
- **[FINAL_TEST_REPORT.md](file:///d:/Whatsapp%20Booster%20Desktop/docs/FINAL_TEST_REPORT.md)** — Typechecks, 60/60 test results aur local D1 / Wrangler build verification.
