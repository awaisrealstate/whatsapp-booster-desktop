# Cloudflare & Meta Free-Tier Limits Analysis (Phase 0)

**Audit Date:** 2026-11-26  
**Budget Constraint:** **\$0 / month** initial infrastructure cost.  
**Policy Notice:** Free-tier quotas, pricing models, and eligible models are set by Cloudflare and Meta and **can change at any time**. No cloud service described below is unlimited or guaranteed permanently free.

---

## 1. Cloudflare Free-Tier Quotas & Upgrade Triggers (Verified 2025/2026 Docs)

| Service | Current Free-Tier Limits | Potential Charges / Overages | Upgrade Trigger (When \$0 Hits a Wall) |
| :--- | :--- | :--- | :--- |
| **Cloudflare Workers** | **100,000 requests/day** (account-wide); **10 ms CPU time** per invocation; **128 MB RAM**; **50 subrequests** per request. | Requests beyond 100k/day fail on Free plan. Workers Paid starts at **\$5/month** (10M reqs/mo + higher CPU limits). | Exceeding 100k API/webhook/cron reqs/day OR complex logic (SSR, heavy crypto, large file parsing) exceeding **10 ms CPU**. |
| **Cloudflare D1 (SQLite)** | **5,000,000 rows read/day**; **100,000 rows written/day**; **5 GB** total account storage; **500 MB max per DB**; up to **10 databases**; max 50 query subrequests/Worker invocation. | Write/read operations fail once daily quota is exhausted until UTC reset. Paid plan bills per million reads/writes and GB stored beyond included allowance. | **100,000 rows written/day** is the earliest trigger during large campaigns or frequent polling; 500 MB DB size cap for high-volume message history. |
| **Cloudflare Queues** | **10,000 operations/day** (pooled across writes, reads, and deletes); **24-hour** max message retention; up to 10,000 queues. | Operations fail once 10k/day is reached. Paid plan includes 1M ops/mo + \$0.40/million additional ops. | At ~3 ops per unbatched message, Free plan caps around ~3,300 individual messages/day unless messages are batched. |
| **Cloudflare Cron Triggers** | **5 Cron Triggers per account**; invocations share the **100,000 req/day** & **10 ms CPU** Workers Free budget. | No extra fee on Free; fails if Worker daily quota is exhausted. Paid allows up to 1,000 crons. | Needing >5 independent cron schedules or heavy batch fan-out exceeding 10 ms CPU per trigger. |
| **Cloudflare R2** | **10 GB-month** standard storage/month; **1,000,000 Class A ops/month** (writes/lists); **10,000,000 Class B ops/month** (reads); **\$0 egress bandwidth fees** (requires payment method on file for R2 activation in many accounts). | Storage above 10 GB-mo (\$0.015/GB-mo) and ops above monthly free cap are metered. | Exceeding 10 GB of stored WhatsApp media/exports without retention cleanup. **Note:** Verify R2 activation requirements (card-on-file policy) before Phase 2. |
| **Workers AI** | **10,000 Neurons/day** (account-wide, resets 00:00 UTC). Certain frontier/large models are **restricted to Workers Paid**. | Requests fail once 10,000 Neurons/day is exhausted on Free; Paid bills \$0.011 per 1,000 Neurons above free daily pool. | High inbound support volume (>300–800 short replies/day depending on model & prompt tokens) or needing larger Paid-only models. |
| **Cloudflare Pages** | **500 deployments/month**; **20,000 files/site** (25 MiB max file size). Static asset requests are currently not metered under the Workers 100k req/day cap on Free, subject to Cloudflare ToS/fair-use; Pages Functions *do* share the 100k req/day & 10 ms CPU Workers quota. | Exceeding 500 deploys/mo blocks new builds; high-bandwidth commercial media abuse may violate fair-use terms. | Exceeding 500 CI deploys/month or needing SSR Functions at scale. |
| **Durable Objects (Optional)** | **100,000 requests/day**; **13,000 GB-seconds duration/day**; **5 GB** account SQLite storage; max 100 classes. | Exhausting `13,000 GB-s/day` stops execution until reset. | Keeping persistent non-hibernating WebSockets (such as Baileys) alive burns duration rapidly — **reason why we avoid DO-hosted WhatsApp Web sockets on Free tier**. |

---

## 2. Meta WhatsApp Cloud API Limits & Cost Boundaries (Verified Docs)

| Item | Current Meta Model | Potential Charges / Restrictions |
| :--- | :--- | :--- |
| **Platform / API Access** | \$0 Meta setup or monthly API fee. | Requires verified Meta Business App & compliance review for production scale. |
| **Inbound User Messages** | \$0 to receive user-initiated messages. | Webhook endpoint must respond within Meta timeout windows (`200 OK` fast). |
| **Service Messages (24h Customer Care Window)** | **1,000 free outbound service messages per business phone number per month** (resets monthly per WABA timezone; counts per outbound message). | Beyond 1,000 messages/month, billed per message at Meta's regional rate card. **Requires a valid payment method on the tenant's Meta account** to exceed the free tier. |
| **Free Entry Points (72h Window)** | Chats opened via Click-to-WhatsApp Ads or Facebook Page CTA grant a **72-hour free messaging window** across categories. | Outside those entry points or after 72h, standard category rates apply. |
| **Marketing / Utility / Auth Templates** | **Billed per delivered message** from message #1 according to recipient country rate card. | Unpaid/missing payment method blocks template delivery. Commercial SaaS tenants connect their own Meta WABA and pay Meta directly. |

---

## 3. Safe Operating Envelope & Architectural Mitigations

To operate reliably inside the **\$0 Cloudflare Free Tier**:
1. **Replace 1-second UI polling** (`dashboard.js#L739`) with `15s–30s` visibility-aware polling or conditional requests (`ETag`) so idle browser tabs don't burn the `100,000 req/day` Worker cap.
2. **Batch Queue messages** (10–25 recipient IDs per Queue message) to reduce Queue operations from ~3 ops/recipient down to ~0.15–0.3 ops/recipient within the `10,000 ops/day` cap.
3. **Keep Excel/CSV parsing in the browser** so Workers stay well below the **`10 ms` CPU limit**.
4. **Use D1 FTS5 + FAQ exact matching before Workers AI** and enforce **per-organization daily AI quotas** so one workspace cannot drain the account-wide `10,000 Neurons/day` pool.
5. **Run R2 object lifecycle expiration** (e.g., auto-delete temporary campaign exports after 30 days) to stay within `10 GB`.
6. **Plan Paid Upgrade Thresholds Early:** Upgrading to Cloudflare Workers Paid (**\$5/month**) is the clear commercialization trigger once tenant volume approaches ~50k req/day, ~70k D1 writes/day, or ~8k Queue ops/day.
