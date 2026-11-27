# Cloudflare Manual Setup Guide (Step-by-Step)

This guide is written so anyone can launch WhatsApp Booster Pro on the **Cloudflare Free Tier (\$0/month)** using the Cloudflare Dashboard and simple Windows PowerShell commands.

> **Important:** Nothing is deployed automatically and **Cloudflare R2 is not used/activated** so no storage billing or card charge is required unless you upgrade later.

---

## Before You Start (2-Minute Checklist)

1. Have a free **Cloudflare account** (`https://dash.cloudflare.com`).
2. Open **PowerShell** inside the project folder:
   ```powershell
   cd "d:\Whatsapp Booster Desktop"
   ```
3. Log Wrangler into your Cloudflare account (this opens your browser once to click **Allow**):
   ```powershell
   npx.cmd wrangler login
   ```
   Verify you are logged in:
   ```powershell
   npx.cmd wrangler whoami
   ```

---

## Step 1: Create Your Copy of the Worker Config Files

Run these 3 commands to copy the example templates into live local config files (which are already `.gitignore`d so secrets are never pushed to GitHub):

```powershell
Copy-Item apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc
Copy-Item apps/worker/wrangler.example.jsonc apps/worker/wrangler.jsonc
Copy-Item apps/web/wrangler.example.jsonc apps/web/wrangler.jsonc
```

---

## Step 2: Create the Cloudflare D1 Database & Apply All 5 Tables/Migrations

1. Create the D1 database:
   ```powershell
   npx.cmd wrangler d1 create wacrm-db
   ```
2. Look at the output in PowerShell — find the line that says:
   ```text
   "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   ```
3. Open both files in Notepad or VS Code and replace `"REPLACE_WITH_D1_ID"` with that real `database_id`:
   - `apps/api/wrangler.jsonc`
   - `apps/worker/wrangler.jsonc`
4. Now apply all 5 SQL migrations (`0001` through `0005`, creating 29 tables + FTS5 search) to Cloudflare D1:
   ```powershell
   npx.cmd wrangler d1 migrations apply wacrm-db --config apps/api/wrangler.jsonc --remote
   ```
   When prompted to confirm, type `y` and press **Enter**.

---

## Step 3: Create the Cloudflare Queue (`wacrm-jobs`)

1. Run:
   ```powershell
   npx.cmd wrangler queues create wacrm-jobs
   ```
   *(If Cloudflare asks to enable Queues in the dashboard on a brand-new account, open **Cloudflare Dashboard > Workers & Pages > Queues** and click Enable — Free tier includes 10,000 operations/day.)*

---

## Step 4: Verify Workers AI Binding (Already Configured)

Both `apps/api/wrangler.jsonc` and `apps/worker/wrangler.jsonc` already include:
```jsonc
"ai": {
  "binding": "AI"
}
```
This binds Cloudflare's built-in Llama model (`@cf/meta/llama-3.1-8b-instruct-fast`) on the Free Tier (`10,000 Neurons/day`). No separate AI API key is needed.

---

## Step 5: Generate and Set Your Encryption Key Secret

Generate a strong random 32-byte key in PowerShell:
```powershell
$encKey = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
Write-Output $encKey
```
Copy that printed key, save a backup in your password manager, and set the **exact same value** on **both** Workers:

```powershell
npx.cmd wrangler secret put ENCRYPTION_KEY --config apps/api/wrangler.jsonc
# Paste your key when prompted and press Enter

npx.cmd wrangler secret put ENCRYPTION_KEY --config apps/worker/wrangler.jsonc
# Paste the SAME key when prompted and press Enter
```

---

## Step 6: Set Up Google OAuth2 (Recommended Login Method)

1. Go to **Google Cloud Console** -> `https://console.cloud.google.com/apis/credentials`.
2. Create or select a project -> **OAuth consent screen** (choose *External*, fill in App Name & Email).
3. Go to **Credentials > Create Credentials > OAuth client ID** -> Application type: **Web application**.
4. Under **Authorized redirect URIs**, add your API Worker callback URL (you'll confirm the exact `.workers.dev` URL after Step 7, or update it right after Step 7):
   ```text
   https://wacrm-api.<YOUR-SUBDOMAIN>.workers.dev/api/v1/auth/oauth/google/callback
   ```
5. Copy the **Client ID** and **Client Secret**, then run:
   ```powershell
   npx.cmd wrangler secret put GOOGLE_CLIENT_ID --config apps/api/wrangler.jsonc
   npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET --config apps/api/wrangler.jsonc
   ```

*(Optional GitHub OAuth2)*: In **GitHub > Settings > Developer settings > OAuth Apps > New OAuth App**, set Authorization callback URL to `https://wacrm-api.<YOUR-SUBDOMAIN>.workers.dev/api/v1/auth/oauth/github/callback`, then run `wrangler secret put GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on `apps/api/wrangler.jsonc`.

---

## Step 7: Deploy the API Worker & Background Engine Worker

1. Deploy `wacrm-api`:
   ```powershell
   npx.cmd wrangler deploy apps/api/src/index.ts --config apps/api/wrangler.jsonc
   ```
   Copy the deployed URL shown in the terminal, e.g.:
   `https://wacrm-api.<YOUR-SUBDOMAIN>.workers.dev`

2. Deploy `wacrm-engine` (handles scheduled campaigns via Cron `*/2 * * * *` and async Queue jobs):
   ```powershell
   npx.cmd wrangler deploy apps/worker/src/index.ts --config apps/worker/wrangler.jsonc
   ```

---

## Step 8: Deploy the Web Dashboard (`apps/web`) to Cloudflare Pages

Run:
```powershell
npx.cmd wrangler pages deploy apps/web --project-name wacrm-web
```
Copy the deployed Pages URL shown at the end, e.g.:
`https://wacrm-web.pages.dev`

---

## Step 9: Update `ALLOWED_ORIGINS` and `WEB_APP_URL` and Re-Deploy API

Open `apps/api/wrangler.jsonc` and update the `"vars"` section to use your real production URLs:

```jsonc
  "vars": {
    "APP_ENV": "production",
    "ALLOWED_ORIGINS": "https://wacrm-web.pages.dev",
    "LOG_LEVEL": "info",
    "PASSWORD_AUTH_ENABLED": "false",
    "META_GRAPH_VERSION": "v21.0",
    "WEB_APP_URL": "https://wacrm-web.pages.dev"
  }
```

Re-deploy the API Worker so the new CORS and OAuth redirect origins take effect:
```powershell
npx.cmd wrangler deploy apps/api/src/index.ts --config apps/api/wrangler.jsonc
```

*(Also double-check that your Google/GitHub OAuth Callback URI from Step 6 matches `https://wacrm-api.<YOUR-SUBDOMAIN>.workers.dev/api/v1/auth/oauth/google/callback`.)*

---

## Step 10: Connect Official Meta WhatsApp Cloud API & Webhook

1. Open your dashboard (`https://wacrm-web.pages.dev`), click **Continue with Google** (or GitHub).
2. In the sidebar, open **WhatsApp Connection** -> fill in your Meta Developer credentials from `https://developers.facebook.com/apps` (**WhatsApp > API Setup**):
   - **Label** (e.g. `Main Business Number`)
   - **WABA ID** (`metaWabaId`)
   - **Phone Number ID** (`metaPhoneNumberId`)
   - **System User Access Token**
   - **App Secret** (*App Settings > Basic > App Secret*)
   - **Webhook Verify Token** (any random phrase you choose, e.g. `my_verify_token_2026`)
3. Save the connection in the dashboard.
4. Go back to **Meta Developer Portal > WhatsApp > Configuration > Webhook > Edit**:
   - **Callback URL:** `https://wacrm-api.<YOUR-SUBDOMAIN>.workers.dev/webhooks/meta`
   - **Verify token:** The exact Webhook Verify Token you entered above
   - Click **Verify and save**, then click **Manage** and **Subscribe** to the **`messages`** webhook field.

---

## Step 11: Configure AI Customer Support & Knowledge Base

1. Open **Knowledge Base** in `apps/web` and add FAQ articles (English or Urdu — e.g., Delivery Timings, Return Policy, Office Hours).
2. Open **AI Support** in `apps/web`:
   - Turn **AI Support Enabled** ON.
   - Review system prompt & handoff keywords (default includes `agent`, `human`, `representative`, `complaint`, `manager`, `support`, `مدد`, `نمائندہ`, `شکایت`).
   - Save settings and send a test WhatsApp message to verify grounded answers and human handoff behavior.

---

## Step 12: Quick Post-Deploy Health Verification

Open these URLs in your browser or PowerShell:
- `https://wacrm-api.<YOUR-SUBDOMAIN>.workers.dev/health` -> should show `"ok": true` and `"database": "ok"`.
- `https://wacrm-api.<YOUR-SUBDOMAIN>.workers.dev/api/v1/status` -> should show `"workersAiConfigured": true` and `"encryptionConfigured": true` (and `"googleOAuthConfigured": true` if configured).
- `https://wacrm-web.pages.dev` -> should load all 15 dashboard views cleanly.
