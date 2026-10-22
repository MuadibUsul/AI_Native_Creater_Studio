# Owner action items

Everything that is waiting on you, the project owner, across the whole project: decisions, accounts, keys, configuration values, external setup, legal work, cost approvals and content only you can provide. The last section lists work that is still not built and what each piece is waiting for.

- **As of:** 2026-10-22, repository HEAD `731c3a3` (branch `codex/v04-foundation`). Updated the same day with your D-01 answer: **global market, not mainland China**. Items that only applied to mainland China are marked "Not needed" below.
- **Sources consolidated here:** `docs/V06/production-readiness-checklist.md`, `docs/V06/integration-checklist.md`, `docs/ops/launch-gate.md`, `docs/ops/deployment-runbook.md`, `docs/V06/milestones/*.md`, `infra/production.env.example` and the configuration schemas in `packages/contracts/src/env.ts`. Those files keep the full technical detail. This document is the to-do list.
- **Secrets rule:** keys and passwords go only into your secrets manager or the server's `infra/production.env`, which is git-ignored. Never put them in the repository, an issue, a commit or a chat log.

## Priority levels

| Level | Meaning |
|---|---|
| **P0** | Needed before any production deployment, including a private beta. |
| **P1** | Needed before opening public sign-up or taking payments (the launch gate). |
| **P2** | Needed to switch on, or truly verify, a specific feature or provider. |
| **P3** | Optional, a quality improvement, or later. |

## Summary

| ID | Item | Priority | Blocks |
|---|---|---|---|
| D-01 | Target markets and data residency | P0 | **Markets decided: global, not mainland China.** Still open: where data is stored (region) |
| D-02 | Brand: product name, logo, domain | P1 | Domain/TLS, email sending domain, legal documents |
| D-03 | Plans, prices and free quota | P1 | Stripe products, usage billing, free-quota enforcement, `ANCS_DEFAULT_PLAN` |
| D-04 | Sign-up policy and login methods | P1 | Building sign-up / password reset |
| D-05 | Content moderation vendor and policy | P1 | Moderation port, launch gate |
| D-06 | Monitoring, alerting and on-call | P1 | Safe operation in production |
| D-07 | Error reporting service | P2 | Error reporting port |
| D-08 | AI editor persona: name, style, default voice | P2 | Final persona prompt and default voice |
| D-09 | Default autonomy tier and budget | P2 | Defaults for "let AI finish the edit" |
| D-10 | Mainland China real-time voice provider | Not needed | (You do not serve mainland China) |
| D-11 | Export without the visible AI label on request | P3 | Building that flow |
| D-12 | Turning on AI-written effect code | P3 | `ANCS_EFFECT_CODEGEN=enabled` |
| D-13 | Fetching reference videos from platform links | P3 | `ANCS_REFERENCE_FETCH_CMD` |
| D-14 | Fate of the retired V4 script/storyboard pipeline | P3 | Rebuilding it with real providers, or removing it |
| D-15 | When to let GitHub Actions run again | P2 | CI evidence for recent commits |
| I-01 | Cloud, region and machines | P0 | Any deployment |
| I-02 | Domain, TLS and reverse proxy | P0 | Any deployment |
| I-03 | Managed PostgreSQL 16 | P0 | Any deployment |
| I-04 | Redis 7 | P1 | Shared rate limits across API machines, BullMQ queue |
| I-05 | Object storage bucket (S3 / R2 / OSS) | P0 | Multi-machine deployment, launch gate machine condition |
| I-06 | Web build settings, including `ANCS_CSP_EXTRA_ORIGINS` | P0 | Browser uploads and playback, API routing, voice |
| I-07 | Production secrets | P0 | Any deployment |
| I-08 | Core production environment values | P0 | Any deployment |
| I-09 | Migrations and first account | P0 | Any deployment |
| I-10 | Scheduled jobs | P1 | Data retention cleanup, event delivery |
| I-11 | Backups and restore drill | P1 | Recoverability |
| I-12 | Network egress allowlist | P2 | Each external provider |
| I-13 | Operations console administrator | P1 | Admin console in production |
| L-01 | Launch gate legal and business items LG-01 to LG-14 | P1 | `ANCS_SAAS_MODE=live` |
| L-02 | AI-content producer code `ANCS_AIGC_PRODUCER_CODE` | Not needed | (China-only requirement) |
| L-03 | China filings: algorithm, generative AI service, ICP | Not needed | (You do not serve mainland China) |
| L-04 | EU AI Act Article 50 position | P1 | Choosing C2PA or another machine-readable mark for EU users |
| L-05 | Remotion licence | P1 | Launch gate LG-12 |
| L-06 | Digital human and voice clone consent wording | P1 | Turning on avatars for users |
| B-01 | Stripe account and products | P1 | Taking payments |
| B-02 | WeChat Pay / Alipay merchant accounts | Not needed | (You do not serve mainland China) |
| B-03 | Email provider and sending domain | P1 | Sign-up, verification, password reset |
| K-01 | AI director model key | P0 | Every AI editing turn |
| K-02 | Footage visual understanding | P2 | "Visuals" understanding on footage |
| K-03 | Batch speech transcription (Deepgram) | P1 | Speech understanding, sentence-safe cuts, captions |
| K-04 | Real-time voice (recognition and spoken replies) | P1 | Talking to the AI editor |
| K-05 | Narration voices (TTS) | P2 | Article-to-video narration |
| K-06 | Digital human (HeyGen + Fish Audio) | P2 | "Use my avatar to say this" |
| K-07 | Video generation (Veo / Seedance / Runway) | P2 | Generated shots, region repaint |
| K-08 | Provider price offers | P2 | Quotes before any paid generation |
| K-09 | Workspace generation budgets | P2 | Confirming any paid generation |
| K-10 | Elorian video understanding | P3 | Integration (not started) |
| K-11 | Pexels test footage key | P3 | Fetching free test footage |
| C-01 | Real Claude evaluation spend | P1 | Real quality evidence for editing and autonomous production |
| C-02 | Small real-generation acceptance runs | P2 | "Verified with the real provider" for each generator |
| C-03 | Real streaming recognition test | P2 | Deepgram live verification |
| C-04 | Entertainment evaluation run | P3 | Entertainment quality numbers |
| M-01 | Real-footage acceptance set with usage rights | P1 | Autonomous production acceptance |
| M-02 | Entertainment originals with usage rights | P3 | C-04 |
| M-03 | Human editors' project files with rights | P3 | CutPrior work (AP-16 to AP-18, AP-21) |

---

## 1. Decisions

### D-01 Target markets and data residency
- **What:** Decide where you will sell first: mainland China, international, or both. If both, decide whether to deploy two separate regions with separate data.
- **Why:** This one choice decides which AI, voice and payment providers are usable, whether Chinese filings are required, where data may be stored, and which moderation vendor fits.
- **Decided (2026-10-22):** global market; you do not serve users in mainland China. Recorded in `docs/V06/production-readiness-checklist.md` section 5 ("数据驻留"). As a result, D-10, L-02, L-03 and B-02 are not needed. L-04 (EU) moves up to P1. Exports now default to an English "AI-generated" badge; the Chinese "AI生成" badge is used only when the user's interface is in Chinese.
- **Still open:** where user data is stored. For example "one region, us-east" or "EU users in eu-central, everyone else in us-east". This drives I-01, I-03 and I-05, and matters for GDPR.
- **Where:** Reply to me; I record it in the same checklist row.
- **Priority:** P0 (the data region only)
- **Blocks:** D-05, I-01 region choice.

### D-02 Brand: product name, logo, domain
- **What:** The final product name, logo files and the production domain.
- **Why:** The web app is still titled "Creator Studio · ANCS". The domain is needed for TLS, `BETTER_AUTH_URL`, the email sending domain and legal documents.
- **Do / provide:** Name, logo (SVG plus 192 px and 512 px PNG icons) and domain, e.g. `studio.example.com`.
- **Where:** Send the files to me; the icons go in `apps/web/public/icons/`, the title in `apps/web/src/app/layout.tsx`, and the domain into I-02 and I-08.
- **Priority:** P1
- **Blocks:** I-02, B-03, L-01 (the policies name the product).

### D-03 Plans, prices and free quota
- **What:** Prices for the existing plans (FREE / CREATOR / PRO / STUDIO / ENTERPRISE), what each includes, and the free monthly quota.
- **Why:** All prices are currently empty. The design target in V6 §10 is a platform cost below US$5 for a 3-minute vlog without video generation, but prices are your call.
- **Do / provide:** A table, e.g. "CREATOR US$19/month, 300 credits, 1080p export; FREE 30 credits/month, watermark-free".
- **Where:** Reply to me. The values feed the Stripe products (B-01) and the plan catalogue in code.
- **Priority:** P1
- **Blocks:** B-01, metering into the billing ledger, free-quota enforcement, `ANCS_DEFAULT_PLAN=FREE` for live mode.

### D-04 Sign-up policy and login methods
- **What:** Open public sign-up, invite-only or waitlist? Email + password only, or also phone, Google, Apple or WeChat?
- **Why:** Today accounts can only be created with the `user:create` command; there is no sign-up, verification or password reset.
- **Do / provide:** For example: "Invite-only beta, email + password, Google login later."
- **Where:** Reply to me.
- **Priority:** P1
- **Blocks:** Building sign-up and password reset (see "Not built yet").

### D-05 Content moderation vendor and policy
- **What:** Pick a moderation service and what to block (e.g. Alibaba Cloud Content Security or Tencent Cloud for mainland; Hive or OpenAI Moderation elsewhere).
- **Why:** Uploads, generations and exports are not moderated at all today.
- **Do / provide:** Vendor name, account and API key, plus a short policy (categories to block, what to do on a hit).
- **Where:** Key in the Worker/API secrets; the policy becomes part of LG-05 and LG-06.
- **Priority:** P1
- **Blocks:** The moderation port (not built), launch gate.

### D-06 Monitoring, alerting and on-call
- **What:** Where alerts go (email, Slack, Feishu, PagerDuty) and who is on call.
- **Why:** Nobody is told today when the API is not ready or exports fail.
- **Do / provide:** Alert channel and on-call names. Example probes: `GET /api/v1/ready` should return 200; if it returns 503 for more than 2 minutes, alert.
- **Where:** Your monitoring platform; see `docs/ops/monitoring-recovery.md`.
- **Priority:** P1
- **Blocks:** Safe production operation.

### D-07 Error reporting service
- **What:** Sentry or a domestic equivalent, and its DSN.
- **Why:** Errors are only in process logs today.
- **Do / provide:** Service choice and the project DSN, e.g. `https://<key>@o0.ingest.sentry.io/0`.
- **Where:** Secrets for API, Worker and Web, once the port is built.
- **Priority:** P2
- **Blocks:** The error reporting port (not built).

### D-08 AI editor persona
- **What:** The editor's name, speaking style and default voice.
- **Why:** The product is meant to feel like working with a professional editor; the persona is still generic.
- **Do / provide:** For example: "Name: 小剪 / Kai; calm, brief, professional; default voice: a warm female voice." A custom voice needs a licensed sample and the provider fee.
- **Where:** Reply to me; the voice id goes into `ANCS_REALTIME_TTS_VOICES_JSON` or `ANCS_NARRATION_VOICES_JSON`.
- **Priority:** P2
- **Blocks:** Final persona prompt and default voice.

### D-09 Default autonomy tier and budget
- **What:** When a user hands a whole edit to the AI, the defaults are currently "show me first" (each change approved) with a US$2 spending cap.
- **Why:** These defaults decide how much the AI does on its own and how much it may spend.
- **Do / provide:** Default tier ("show me first" or "use it if the self-check passes") and the default cap, e.g. "US$3, show me first".
- **Where:** Reply to me; I change the defaults in the new-project and studio setup forms.
- **Priority:** P2
- **Blocks:** Nothing hard; the current defaults are safe.

### D-10 Mainland China real-time voice provider
- **What:** A domestic streaming speech-recognition and speech-synthesis vendor (e.g. Alibaba Cloud, Volcano Engine, iFlytek).
- **Why:** The verified voice path uses an OpenAI-compatible gateway, which is not suitable for mainland users. V6 §9 plans region routing.
- **Do / provide:** Vendor choice, account and keys.
- **Where:** Real-time gateway secrets; the adapter is not built yet.
- **Priority:** Not needed (D-01: you do not serve mainland China)
- **Blocks:** Nothing for you.

### D-11 Export without the visible AI label on request
- **What:** The labelling rules allow giving a user a copy without the visible "AI生成" badge if the user agreement states the user's labelling duty and logs are kept for at least 6 months.
- **Why:** Some creators will ask for it; it carries legal responsibility.
- **Do / provide:** Yes or no. If yes, the agreement wording (from counsel).
- **Where:** Reply to me; the wording goes into the Terms (LG-08).
- **Priority:** P3
- **Blocks:** Building that flow (not built). The metadata label stays in every case.

### D-12 Turning on AI-written effect code
- **What:** Whether the AI may write its own effect code when templates are not enough.
- **Why:** It is gated off (`ANCS_EFFECT_CODEGEN=disabled`) until an evaluation shows the safety gates and quality are good enough.
- **Do / provide:** Approve the evaluation in `docs/V06/milestones/V6-3.md` (uses the director model, so it has a cost), then decide.
- **Where:** Worker env `ANCS_EFFECT_CODEGEN=enabled`.
- **Priority:** P3
- **Blocks:** AI-written effects.

### D-13 Fetching reference videos from platform links
- **What:** "Learn style from a reference video" can download from links such as YouTube using `yt-dlp`.
- **Why:** It must respect platform terms and copyright. Platforms often block data-centre IPs.
- **Do / provide:** Yes or no. If yes, install `yt-dlp` on Worker machines and set the command.
- **Where:** Worker env, e.g. `ANCS_REFERENCE_FETCH_CMD="yt-dlp --no-playlist -f mp4/bestvideo*+bestaudio/best -o {output} {url}"`.
- **Priority:** P3
- **Blocks:** Pasting platform links (uploading files already works).

### D-14 Fate of the retired V4 pipeline
- **What:** The old script → storyboard flow only ever had test doubles. It is now off in production (`ANCS_LEGACY_PIPELINE` defaults to `off`), and its pages point users to the studio.
- **Why:** You can keep it retired, delete it later, or pay to rebuild it on real providers.
- **Do / provide:** A decision. Recommended: keep it retired; everything users need is in the studio.
- **Where:** Reply to me.
- **Priority:** P3
- **Blocks:** Nothing today.

### D-15 When to let GitHub Actions run again
- **What:** Per your instruction, every recent commit carries `[skip ci]`, so CI has not run on them. The CI workflow now also starts SeaweedFS for the storage tests, a step that has not yet run in GitHub.
- **Why:** Before launch you will want one full green CI run as independent evidence.
- **Do / provide:** Tell me when to push a commit without `[skip ci]`, or run the workflow manually.
- **Where:** `.github/workflows/ci.yml`; GitHub Actions tab.
- **Priority:** P2
- **Blocks:** CI evidence for recent work.

---

## 2. Infrastructure and deployment

### I-01 Cloud, region and machines
- **What:** Choose a cloud and region (per D-01) and the machine layout.
- **Why:** The Docker images and a single-machine compose file exist (`Dockerfile`, `infra/docker-compose.prod.yml`) and were rehearsed in a real browser. They need somewhere to run.
- **Do / provide:** Machines or a container platform for four processes:
  - `web` (Next.js, port 3000)
  - `api` (port 3001, internal only)
  - `realtime` (voice gateway, port 3002)
  - `worker` (FFmpeg + Chromium, CPU-heavy)

  Sizing has not been measured. A starting point to adjust after measuring (not a measured figure): 4 vCPU / 8 GB RAM per Worker.
- **Where:** Your cloud console. Build steps are in `docs/ops/deployment-runbook.md` §10.
- **Priority:** P0
- **Blocks:** Any deployment.

### I-02 Domain, TLS and reverse proxy
- **What:** DNS and a TLS certificate for the production domain, and a reverse proxy in front of the services.
- **Why:** Browsers only talk to the Web origin. The API stays internal; voice uses a WebSocket path.
- **Do / provide:**
  - `https://<domain>/` → `web:3000`
  - `wss://<domain>/realtime/v1/voice` → `realtime:3002` (WebSocket upgrade)
  - Expose ports by setting `ANCS_WEB_PUBLISH` and `ANCS_REALTIME_PUBLISH` in `infra/production.env` (both default to `127.0.0.1` binds).
  - Set `ANCS_TRUST_PROXY_HOPS=1` if exactly one proxy sits in front.
- **Where:** DNS provider, proxy configuration, `infra/production.env`.
- **Priority:** P0
- **Blocks:** Any deployment; HTTPS is also a launch gate machine condition.

### I-03 Managed PostgreSQL 16
- **What:** A managed PostgreSQL 16 database with point-in-time recovery.
- **Why:** It is the system of record (projects, edit history, billing).
- **Do / provide:**
  - The connection string, e.g. `postgres://ancs:<password>@db.internal:5432/ancs?sslmode=require`.
  - Optional pool settings:
    - `ANCS_DB_POOL_MAX`, default 5 per process. The total across all processes must stay under the database's `max_connections`.
    - `ANCS_DB_CONNECT_TIMEOUT_MS`, e.g. `10000`.
    - `ANCS_DB_STATEMENT_TIMEOUT_MS`, e.g. `60000`.
- **Where:** `DATABASE_URL` and the pool settings in the secrets for API, Worker, realtime and the CLIs. With the bundled compose database, set `POSTGRES_PASSWORD` instead.
- **Priority:** P0
- **Blocks:** Any deployment.

### I-04 Redis 7
- **What:** A managed Redis 7.
- **Why:** It is optional for a single machine. With several API machines it makes rate limits shared instead of per machine. It can also back the job queue (BullMQ).
- **Do / provide:** The URL, e.g. `rediss://default:<password>@cache.internal:6380`.
- **Where:**
  - API: `ANCS_RATE_LIMIT_REDIS_URL`. The API refuses to start if it is unreachable; at run time it falls back to per-process limits.
  - Worker (optional): `ANCS_QUEUE_DRIVER=bullmq` plus `REDIS_URL`.
- **Priority:** P1 (P3 on a single machine)
- **Blocks:** Consistent rate limiting across API machines.

### I-05 Object storage bucket (S3 / R2 / OSS)
- **What:** A private bucket for all media (uploads, proxies, previews, exports).
- **Why:** Local disk forces API and Worker onto one machine. `ANCS_STORAGE_DRIVER=s3` is built and was verified end to end on a signature-checking S3 server, but it needs your real bucket. Live mode refuses `local` storage.
- **Do / provide:**
  1. **Create the bucket.** Use AWS S3, Cloudflare R2, Alibaba Cloud OSS or another S3-compatible store. Keep public access off.
  2. **Create an access key** limited to that bucket:
     - `s3:ListBucket` on the bucket. This is required: without it S3 returns 403 instead of 404 for missing objects.
     - `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:AbortMultipartUpload` on its objects.
  3. **CORS** (browsers upload and play directly). AWS-style example:
     ```json
     [{"AllowedOrigins":["https://studio.example.com"],"AllowedMethods":["GET","PUT","HEAD"],"AllowedHeaders":["content-type","range"],"ExposeHeaders":["ETag","Content-Length","Content-Range","Accept-Ranges"],"MaxAgeSeconds":3600}]
     ```
  4. **Lifecycle rule:** abort incomplete multipart uploads after 1 day. If you turn on versioning (recommended, see I-11), also expire noncurrent versions, e.g. after 30 days.
  5. **Environment.** Set the same values on API, Worker and the retention CLI:
     ```
     ANCS_STORAGE_DRIVER=s3
     ANCS_S3_BUCKET=ancs-media-prod
     ANCS_S3_REGION=us-east-1            # R2: auto
     ANCS_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # only for non-AWS stores
     ANCS_S3_PUBLIC_ENDPOINT=            # only if browsers reach a different endpoint than servers
     ANCS_S3_FORCE_PATH_STYLE=0          # 1 for self-hosted stores such as SeaweedFS
     ANCS_S3_ACCESS_KEY_ID=...
     ANCS_S3_SECRET_ACCESS_KEY=...
     ANCS_S3_KEY_PREFIX=prod/            # optional, to share one bucket between environments
     ```
     Leave both key variables unset to use the machine's cloud role instead. The API checks the bucket at start-up and refuses to start if the bucket, region or key is wrong.
  6. **CSP:** set `ANCS_CSP_EXTRA_ORIGINS` when building the web image (I-06).
- **Where:** Cloud storage console; `infra/production.env` or secrets manager. Full notes: `docs/ops/deployment-runbook.md` §10.3.
- **Priority:** P0 for a multi-machine deployment; P1 for live mode
- **Blocks:** Horizontal scaling, live mode machine condition, removing the shared `storage` volume.

### I-06 Web build settings
- **What:** Three values that are baked into the web image at build time:
  - `ANCS_API_INTERNAL_URL`, the API address the web server forwards `/api/v1/*` to, e.g. `http://api:3001`.
  - `NEXT_PUBLIC_ANCS_REALTIME_URL`: leave empty to use `/realtime/v1/voice` on the web origin, or set it to e.g. `wss://voice.example.com/realtime/v1/voice`.
  - `ANCS_CSP_EXTRA_ORIGINS`, the extra origins the browser may connect to and play media from (comma-separated, full origins).
- **Why:** With S3 storage, the browser uploads to and plays from the bucket's origin. Without it in the CSP, uploads fail (this was found and fixed during verification). A separate voice origin must also be listed.
- **Do / provide:** The bucket's browser origin. Examples:
  - AWS: `https://ancs-media-prod.s3.us-east-1.amazonaws.com`
  - R2: the host shown in a presigned URL
  - Path-style or custom endpoint: the origin of `ANCS_S3_PUBLIC_ENDPOINT` or `ANCS_S3_ENDPOINT`

  Build command:
  ```
  docker build --target runtime -t ancs:runtime \
    --build-arg ANCS_API_INTERNAL_URL=http://api:3001 \
    --build-arg NEXT_PUBLIC_ANCS_REALTIME_URL= \
    --build-arg ANCS_CSP_EXTRA_ORIGINS=https://ancs-media-prod.s3.us-east-1.amazonaws.com .
  ```
- **Where:** Docker build arguments (`Dockerfile` `build` stage).
- **Priority:** P0
- **Blocks:** Browser uploads and playback on S3; API routing; voice on a separate origin.

### I-07 Production secrets
- **What:** Four independent random secrets, plus a database password if you use the bundled database.
- **Why:** Each protects a different surface; the code refuses shared or derived values in production.
- **Do / provide:** Generate each separately and store them in your secrets manager:
  ```
  BETTER_AUTH_SECRET=$(openssl rand -base64 32)          # sessions
  ANCS_STORAGE_SECRET=$(openssl rand -base64 32)         # local-storage signed URLs (not needed with s3)
  ANCS_CREDENTIAL_KEYS=v1:$(openssl rand -base64 32)     # encrypts stored provider credentials; same value on API and Worker
  ANCS_VOICE_SESSION_SECRET=$(openssl rand -base64 32)   # voice session tokens; same value on API and realtime
  POSTGRES_PASSWORD=$(openssl rand -hex 16)              # only with the bundled database
  ```
- **Where:** Secrets manager, or the git-ignored `infra/production.env` on the server.
- **Priority:** P0
- **Blocks:** Any deployment.

### I-08 Core production environment values
- **What:** The non-secret values every production deployment needs.
- **Why:** The processes validate configuration at start-up and refuse to start when something is missing.
- **Do / provide:** Start from `infra/production.env.example` and set:
  ```
  NODE_ENV=production
  BETTER_AUTH_URL=https://studio.example.com
  ANCS_STORAGE_PUBLIC_BASE_URL=https://studio.example.com   # local storage only
  ANCS_OPS_ENVIRONMENT=PRODUCTION
  ANCS_ALLOWED_ORIGINS=                # empty = origin of BETTER_AUTH_URL
  ANCS_TRUST_PROXY_HOPS=1
  ANCS_SHUTDOWN_DRAIN_SECONDS=5
  ANCS_SHUTDOWN_TIMEOUT_SECONDS=30
  ANCS_SAAS_MODE=internal              # switch to live only at launch (L-01)
  ```
  Leave `ANCS_LEGACY_PIPELINE` and `ANCS_ALLOW_MOCK_PROVIDERS` unset: production runs with no test doubles.
- **Where:** `infra/production.env` or your platform's environment settings, per process (see `docs/ops/deployment-runbook.md` §2).
- **Priority:** P0
- **Blocks:** Any deployment.

### I-09 Migrations and first account
- **What:** Apply database migrations on every deploy, and create the first account.
- **Why:** There is no public sign-up yet; the first user is created with a command.
- **Do / provide:**
  - The compose file runs the `migrate` service before the API starts. On other platforms run `node apps/api/dist/cli/migrate.js` (or `pnpm db:migrate`). It takes a lock, so concurrent runs are safe.
  - Create the first account; the password goes only through the environment:
    ```
    ANCS_NEW_USER_PASSWORD='…' docker compose -f infra/docker-compose.prod.yml --env-file infra/production.env \
      run --rm --no-deps -e ANCS_NEW_USER_EMAIL=owner@example.com -e ANCS_NEW_USER_PASSWORD api node apps/api/dist/cli/create-user.js
    ```
- **Where:** Your deploy pipeline / a one-off command.
- **Priority:** P0
- **Blocks:** Any use of the deployment.

### I-10 Scheduled jobs
- **What:** Run the retention cleanup and event delivery on a schedule.
- **Why:** These exist only as commands today. Without them, expired drafts and trash are never removed and outbound events are not retried.
- **Do / provide:**
  - Daily: `node apps/api/dist/cli/retention-sweep.js`, with the same storage settings as the API.
  - Every minute: `node apps/api/dist/cli/event-dispatch.js`.

  Optional tuning: `ANCS_TRASH_RETENTION_DAYS`, `ANCS_IDEMPOTENCY_TTL_HOURS`.
- **Where:** Your platform's scheduler (cron, Kubernetes CronJob, cloud scheduler). I can add a sample on request.
- **Priority:** P1
- **Blocks:** Data retention promises (LG-14), storage cost control.

### I-11 Backups and restore drill
- **What:** Point-in-time recovery on the database, versioning on the bucket, and a tested restore.
- **Why:** User projects and media must survive mistakes and incidents.
- **Do / provide:**
  1. Enable PITR on the database (e.g. 7-day window).
  2. Enable bucket versioning with noncurrent-version expiry (I-05).
  3. Run the existing drill against a staging copy (`pnpm recovery:rehearsal`) and keep the result.
- **Where:** Database and storage consoles; `scripts/recovery-rehearsal.mjs`.
- **Priority:** P1
- **Blocks:** Recoverability claims in the privacy and data retention documents.

### I-12 Network egress allowlist
- **What:** Outbound access from Worker and realtime machines to the providers you enable.
- **Why:** Calls to blocked hosts fail. For example, Seedance could not be tested because `*.volces.com` was blocked in the development environment.
- **Do / provide:** Allow the hosts for the providers you use:

  | Provider | Hosts to allow |
  |---|---|
  | Anthropic (Claude) | `api.anthropic.com`, or your gateway |
  | Gemini | `generativelanguage.googleapis.com` |
  | OpenAI-compatible voice | `api.openai.com`, or your gateway |
  | Deepgram | `api.deepgram.com` |
  | Fish Audio | `api.fish.audio` |
  | HeyGen | `api.heygen.com`, `upload.heygen.com`, plus the video download host returned by the first job |
  | Seedance | `ark.cn-beijing.volces.com`, `*.tos-cn-beijing.volces.com` |
  | Runway | `api.dev.runwayml.com`, plus its download host |
  | yt-dlp (D-13 only) | The platform's page and media hosts |
  | Object storage | Your storage endpoint |
- **Where:** Firewall / egress policy of your cloud.
- **Priority:** P2
- **Blocks:** Each provider listed.

### I-13 Operations console administrator
- **What:** Who may sign in to the operations console (`/admin`) in production, and with which role.
- **Why:** Operator identities are stored as admin principals with role grants. The old `ANCS_PLATFORM_ADMINS` setting no longer grants anything. A production bootstrap command does not exist yet; only test helpers create operators today.
- **Do / provide:** The operator email addresses and roles you want, and confirm `ANCS_OPS_ENVIRONMENT=PRODUCTION` on the API. Ask me to build the bootstrap command (see "Not built yet").
- **Where:** Reply to me; then a one-off command against the production database.
- **Priority:** P1
- **Blocks:** Using the operations console in production.

---

## 3. Legal and compliance

### L-01 Launch gate items LG-01 to LG-14
- **What:** The fourteen human conditions in `docs/ops/launch-gate.md`. All are currently `BLOCKED`.
- **Why:** `ANCS_SAAS_MODE=live` (public sign-up and payments) requires every item to be `APPROVED` with evidence. The API also enforces the machine conditions at start-up.
- **Do / provide:** For each item, a document version, contract number or signed date as evidence.
  - **Provider terms:**
    - LG-01: review each provider's current terms.
    - LG-02: white-label and end-user access rights.
    - LG-03: sign any enterprise agreements those reviews require.
  - **Consent:**
    - LG-04: digital human and voice clone consent wording and flow (see L-06).
  - **Policies:**
    - LG-05: content policy.
    - LG-06: abuse policy.
    - LG-07: privacy policy. It must state honestly that "no training" is not the same as "no storage", and that deleting outputs does not delete logs.
    - LG-08: terms of service.
    - LG-09: DPA for each target market.
  - **Business:**
    - LG-10: legal entity, invoicing and tax.
    - LG-11: real payment channel (see B-01).
  - **Licences:**
    - LG-12: Remotion licence (see L-05).
  - **Publishing:**
    - LG-13: publish the policy pages with versions kept.
    - LG-14: public data retention and deletion statement that matches the implementation.
- **Where:** Evidence goes into the table in `docs/ops/launch-gate.md`. Afterwards run `node scripts/launch-gate-check.mjs --live`; it must exit 0.
- **Priority:** P1
- **Blocks:** Live mode (public sign-up and charging).

### L-02 AI-content producer code (`ANCS_AIGC_PRODUCER_CODE`)
- **What:** The service provider code written into every labelled export's `AIGC` metadata (`ContentProducer` / `ContentPropagator`).
- **Why:** Since 2025-09-01, China's labelling measures and the GB 45438-2025 standard require it. Exports that contain AI-generated media already get the visible "AI生成" badge and the `AIGC` metadata field, but the producer field stays empty until you set this. The Worker warns at start-up in production when it is missing.
- **Do / provide:** Your code in the format of the TC260 practice guide. It is built from your organisation's 18-character Unified Social Credit Code, a service-type digit (`1` = generation service) and a 4-character service number. Confirm the exact layout with counsel. Allowed characters: letters, digits, `_` and `-`, up to 64.
- **Where:** Worker env `ANCS_AIGC_PRODUCER_CODE=<code>`.
- **Priority:** Not needed (D-01). Leave it unset; the Worker prints a one-line reminder at start-up in production, which you can ignore.
- **Blocks:** Nothing for you.

### L-03 China filings
- **What:** Algorithm filing (算法备案), generative AI service filing (生成式人工智能服务备案) and ICP filing (ICP 备案).
- **Why:** Required to offer generative AI services to the mainland public.
- **Do / provide:** Confirm with counsel which apply, then file them. Tell me if a filing needs technical documents.
- **Where:** The relevant regulator portals; record the numbers in `docs/ops/launch-gate.md`.
- **Priority:** Not needed (D-01: you do not serve mainland China)
- **Blocks:** Nothing for you.

### L-04 EU AI Act Article 50 position
- **What:** The Article 50 transparency obligations have applied since 2026-08-02. They cover machine-readable marking of synthetic content and disclosure of deepfakes.
- **Why:** Today exports that contain AI-generated media carry a visible badge ("AI-generated" in English, "AI生成" in Chinese) and the `AIGC` metadata field from the Chinese standard. The EU commonly expects C2PA content credentials, which need a signing certificate.
- **Do / provide:** Counsel's view on whether the current labels suffice for your EU users. If C2PA is needed, buy a C2PA signing certificate and tell me.
- **Where:** Reply to me; the certificate goes into the secrets manager.
- **Priority:** P1 (a global launch includes the EU)
- **Blocks:** C2PA support (not built).

### L-05 Remotion licence
- **What:** A commercial licence for Remotion, used for graphics and effect rendering.
- **Why:** Companies above Remotion's free-use threshold must buy a licence; check the current terms on remotion.dev.
- **Do / provide:** Licence type and number, or written confirmation that you qualify for free use.
- **Where:** `docs/ops/launch-gate.md` LG-12.
- **Priority:** P1
- **Blocks:** Launch gate.

### L-06 Digital human and voice clone consent
- **What:** The consent text users accept before uploading their photo or voice sample, and what you promise about storage and withdrawal.
- **Why:** The product already stores append-only consent records and supports withdrawal. The wording must come from counsel.
- **Do / provide:** Approved consent text in Chinese and English.
- **Where:** Send it to me; it goes into the identity page and LG-04.
- **Priority:** P1 (before offering avatars to users)
- **Blocks:** Turning on avatars and voices for users.

---

## 4. Payments and email

### B-01 Stripe account and products
- **What:**
  - A Stripe account with products and prices matching D-03.
  - Stripe Tax if you need it.
  - Test-mode and live-mode API keys.
  - A webhook endpoint signing secret.
- **Why:** Payments are still a test double; setting `ANCS_PAYMENTS_DRIVER=stripe` fails at start-up because the adapter is not built.
- **Do / provide:** Create the account and products; share test-mode keys first so I can build and verify the adapter (Checkout, customer portal, webhook signature checks, de-duplication, reconciliation). Exact variable names will be fixed when the adapter is built; expect a secret key and a webhook signing secret.
- **Where:** Stripe dashboard; secrets manager.
- **Priority:** P1
- **Blocks:** Taking payments; launch gate LG-11; live mode machine condition.

### B-02 WeChat Pay / Alipay merchant accounts
- **What:** Merchant accounts for mainland payments.
- **Why:** Stripe does not cover typical mainland consumer payments. These accounts need a legal entity in China.
- **Do / provide:** Decide whether to open them; if so, open them and share sandbox credentials.
- **Where:** WeChat Pay and Alipay merchant platforms.
- **Priority:** Not needed (D-01: you do not serve mainland China)
- **Blocks:** Nothing for you.

### B-03 Email provider and sending domain
- **What:**
  - A transactional email provider (any SMTP service, or e.g. Amazon SES, Postmark, Alibaba Cloud DirectMail).
  - A sending address, e.g. `no-reply@studio.example.com`.
  - DNS records for the sending domain: SPF, DKIM and DMARC.
- **Why:** The repository cannot send email at all yet. Sign-up verification and password reset need it.
- **Do / provide:** Provider account plus SMTP host, port, user and password (or API key); the from-address; DNS records published and verified by the provider.
- **Where:** Email provider console, DNS, secrets manager. Variable names will be fixed when the email port is built.
- **Priority:** P1
- **Blocks:** Sign-up, email verification and password reset (not built).

---

## 5. AI providers: keys, quotas and settings

Each row below has working code. The "Verified" line says whether a real call has been made. Full variable details: `docs/V06/integration-checklist.md`.

### K-01 AI director model
- **What:** A production key for the model that runs every editing turn and autonomous production.
- **Why:** Without it, every AI turn fails with "the AI director isn't configured yet".
- **Do / provide:** One of:
  - Anthropic: `ANCS_AGENT_DRIVER=anthropic`, `ANTHROPIC_API_KEY`. Optional `ANCS_AGENT_MODEL`. Set `ANCS_ANTHROPIC_BASE_URL` (https, up to but not including `/v1`) when you use a compatible gateway.
  - Gemini: `ANCS_AGENT_DRIVER=gemini`, `GEMINI_API_KEY`, optional `ANCS_AGENT_MODEL`.
- **Verified:**
  - Gemini: yes, the full browser flow ran on it.
  - Anthropic: tool calling and the real browser voice flow ran through a gateway. The editing-quality evaluations have not been run (C-01).
- **Where:** Worker secrets.
- **Priority:** P0
- **Blocks:** The core product.

### K-02 Footage visual understanding
- **What:** A vision model that describes shots so the AI can search footage by what is seen.
- **Do / provide:** `ANCS_VISUAL_ANALYSIS_DRIVER=anthropic` or `gemini` with the matching key; optional `ANCS_VISION_MODEL`.
- **Verified:** Gemini yes; Anthropic no.
- **Where:** Worker secrets.
- **Priority:** P2
- **Blocks:** "Visuals: understood" on footage cards (the AI can still look at frames directly).

### K-03 Batch speech transcription (Deepgram)
- **What:** Word-level transcripts with speakers for uploaded footage.
- **Why:** Needed for speech understanding, captions from the original audio, and never cutting mid-sentence.
- **Do / provide:** `ANCS_ASR_DRIVER=deepgram`, `DEEPGRAM_API_KEY`; optional `ANCS_DEEPGRAM_MODEL`, `ANCS_DEEPGRAM_LANGUAGE`.
- **Verified:** Adapter checked against the real service earlier; full product flow not yet run with a key.
- **Where:** Worker secrets.
- **Priority:** P1
- **Blocks:** Speech-aware editing and captions.

### K-04 Real-time voice
- **What:** Streaming recognition for talking to the editor, and spoken replies.
- **Do / provide:**
  - Shared settings: `ANCS_VOICE_SESSION_SECRET` (I-07, same value on API and realtime) and `ANCS_ALLOWED_ORIGINS` on the realtime gateway.
  - Recognition: either `ANCS_REALTIME_ASR_DRIVER=openai` with `OPENAI_API_KEY` (and `ANCS_OPENAI_BASE_URL` including `/v1` for a gateway), or `ANCS_REALTIME_ASR_DRIVER=deepgram` with `DEEPGRAM_API_KEY`.
  - Spoken replies: `ANCS_REALTIME_TTS_DRIVER=openai`, with optional `ANCS_REALTIME_TTS_VOICES_JSON`, e.g. `[{"id":"coral","name":"Coral"}]`.
- **Verified:** The OpenAI-compatible path is verified end to end. Deepgram streaming is not (C-03). There is no mainland provider yet (D-10).
- **Where:** Realtime gateway secrets; reverse proxy route (I-02).
- **Priority:** P1
- **Blocks:** The voice-first experience.

### K-05 Narration voices
- **What:** Text-to-speech for article narration and narration tracks.
- **Do / provide:** One of:
  - Gemini TTS: `ANCS_NARRATION_DRIVER=gemini` with `GEMINI_API_KEY`. Verified in Chinese. The free tier allows only 10 requests per model per day, so enable a paid tier.
  - Fish Audio: `ANCS_NARRATION_DRIVER=fish`, `FISH_AUDIO_API_KEY` and `ANCS_NARRATION_VOICES_JSON`. Verified only against a local stand-in (C-02).
  - `flite`: English only, no key needed.
- **Where:** Worker secrets.
- **Priority:** P2
- **Blocks:** Article-to-video narration in production.

### K-06 Digital human
- **What:** HeyGen (talking photo) plus Fish Audio (your voice).
- **Do / provide:** `ANCS_AVATAR_DRIVER=heygen`, `HEYGEN_API_KEY` and `FISH_AUDIO_API_KEY`. Set `ANCS_AVATAR_OFFER_JSON` with prices from your HeyGen plan. Allow the HeyGen hosts (I-12).
- **Verified:** Only against local stand-ins (C-02).
- **Where:** Worker secrets.
- **Priority:** P2
- **Blocks:** "Use my avatar to say this"; also needs L-06 and K-09.

### K-07 Video generation
- **What:** Generated shots and region repaint. Each provider has the same cost safeguards: quote first, the user confirms, the budget is reserved, the provider is called once, and there are no automatic paid retries.
- **Do / provide:**
  - **Veo:** enable Google Cloud billing (the free tier has no Veo quota; a 4-second test was rejected with no charge). Set `ANCS_VEO_OFFER_JSON`.
  - **Seedance:** `ARK_API_KEY`, `ANCS_SEEDANCE_OFFER_JSON`, and network access to `*.volces.com`.
  - **Runway:** buy credits. Set `RUNWAYML_API_SECRET` and `ANCS_RUNWAY_OFFER_JSON`.
  - **Any other vendor:** `ANCS_GENERATION_DRIVER=process` with your own small program (see `scripts/generation-process-example.mjs`).
- **Verified:**
  - Runway: authentication works against the real service; no generation has been run yet.
  - Veo and Seedance: no real generation yet (C-02).
- **Where:** Worker secrets.
- **Priority:** P2
- **Blocks:** Generated shots, region repaint.

### K-08 Provider price offers
- **What:** The per-second price range and single-run cap for each generator, in US-dollar micro-units.
- **Why:** The platform does not ship any vendor prices. Quotes, budget reservations and settlement all come from these values.
- **Do / provide:** Read each vendor's current price page and fill the JSON, e.g.
  ```
  {"kind":"VIDEO_SHOT","providerId":"veo","implementation":"REAL","model":"<model id>","perSecondMicros":{"min":<from price page>,"max":<from price page>},"maxSeconds":8,"durationOptions":[4,6,8]}
  ```
  Seedance bills in RMB per token; convert to USD per second.
- **Where:** `ANCS_VEO_OFFER_JSON`, `ANCS_SEEDANCE_OFFER_JSON`, `ANCS_RUNWAY_OFFER_JSON`, `ANCS_AVATAR_OFFER_JSON` and `ANCS_GENERATION_OFFERS_JSON` (Worker).
- **Priority:** P2
- **Blocks:** Every paid generation.

### K-09 Workspace generation budgets
- **What:** Each workspace must have a generation budget before any paid generation can be confirmed.
- **Do / provide:** Set it in the workspace billing settings, or with `PUT /api/v1/workspaces/:id/billing/budget`. Decide a default policy for new workspaces.
- **Where:** Product UI / API.
- **Priority:** P2
- **Blocks:** Confirming paid generations (they are refused otherwise).

### K-10 Elorian video understanding
- **What:** A candidate service for complex event understanding and active re-watching (Proposal 0.1).
- **Do / provide:** API documentation, an account, and its data terms.
- **Where:** Send to me.
- **Priority:** P3
- **Blocks:** That integration (not started).

### K-11 Pexels test footage key
- **What:** A free key for downloading licensed test footage for evaluations.
- **Do / provide:** `PEXELS_API_KEY` from https://www.pexels.com/api/.
- **Where:** Local or evaluation environment only, never production.
- **Priority:** P3
- **Blocks:** `scripts/fetch-pexels-footage.mjs`.

---

## 6. Cost approvals

Nothing that costs money is run without your explicit approval. Each item needs a key from section 5 and a spending cap from you. Example values below are placeholders for you to replace, not estimates.

| ID | What would run | Needs | Why | Example of what to tell me | Priority |
|---|---|---|---|---|---|
| C-01 | Real Claude evaluation runs: first-cut evaluation (`scripts/eval-first-cut.mjs`), autonomous-production evaluation on real footage, full browser flow | K-01 Anthropic key, M-01 footage | Autonomous production has only been verified with a scripted director; real editing quality and honest reports are unproven | "Approved up to US$<amount> for Claude evaluation" | P1 |
| C-02 | One small real generation per provider: Fish Audio (one sentence), HeyGen (about 2 s), Veo (4 s), Seedance (5 s), Runway (2 s) | K-05, K-06, K-07, I-12 | Each generator is so far only tested against local stand-ins | "Approved: Fish + HeyGen + Veo, cap US$<amount> total" | P2 |
| C-03 | Real Deepgram streaming test (`scripts/voice-live-check.mjs`) | K-04 Deepgram key | Streaming recognition has only run through the OpenAI-compatible path | "Approved, cap US$<amount>" | P2 |
| C-04 | Entertainment evaluation set (`docs/V06/milestones/V6-8.md`) | K-01, K-03, M-02 | Quality numbers for entertainment content | "Approved, cap US$<amount>" | P3 |

Also on your side: the running cost of every provider, cloud resources and the email service once in production.

---

## 7. Content and data only you can provide

### M-01 Real-footage acceptance set
- **What:** The Proposal 0.1 §12.2 set, with written permission to use it for testing:
  - a 10-minute talking-head video
  - a 20-minute vlog
  - a 30-minute tutorial
  - 60 minutes of gameplay
  - a story with deliberately insufficient footage
- **Why:** Autonomous production must be accepted on real material, not synthetic clips.
- **Where:** Upload to a private location and send me the link; files go into the git-ignored `Videos/` folder, never the repository.
- **Priority:** P1
- **Blocks:** C-01; autonomous production acceptance.

### M-02 Entertainment originals
- **What:** Entertainment footage you have the right to use.
- **Where:** `Videos/` (git-ignored); see `docs/V06/milestones/V6-8.md`.
- **Priority:** P3
- **Blocks:** C-04.

### M-03 Human editors' project files
- **What:** Professional editors' project files (e.g. Premiere or CapCut projects) with the right to learn from them.
- **Why:** Proposal 0.2 "CutPrior" learns editing habits from them. That work is paused until the source and rights are settled.
- **Where:** Reply with the source and licence terms first.
- **Priority:** P3
- **Blocks:** AP-16 to AP-18 and AP-21.

---

## 8. Launch sequence (once the items above are done)

1. **Deploy.** Run I-01 to I-09 with `ANCS_SAAS_MODE=internal` and invite a small group.
2. **Verify with real providers.** Run C-01 to C-03 and record the results in the milestone files.
3. **Approve the launch gate.** Complete L-01 to L-06 and B-01 to B-03, then mark each launch gate row `APPROVED` with its evidence.
4. **Check machine conditions.** Set `ANCS_DEFAULT_PLAN=FREE`, `ANCS_PAYMENTS_DRIVER=stripe` (after the adapter is built), `ANCS_STORAGE_DRIVER=s3`, an `https://` `BETTER_AUTH_URL`, and `ANCS_OPS_ENVIRONMENT=PRODUCTION`.
5. **Run the gate check.** `node scripts/launch-gate-check.mjs --live` must exit 0.
6. **Go live.** Set `ANCS_SAAS_MODE=live` and redeploy. The API re-checks the machine conditions at start-up.

---

## Not built yet

| Work | Status | Waiting on |
|---|---|---|
| Email sign-up, email verification, password reset, email sending port | Not started | D-04, B-03 |
| Stripe adapter (Checkout, customer portal, webhooks, de-duplication, reconciliation) | Not started; `ANCS_PAYMENTS_DRIVER=stripe` fails at start-up on purpose | B-01 (test keys), D-03 |
| WeChat Pay / Alipay adapters | Not planned (D-01: no mainland China) | — |
| Metering AI usage into the billing ledger (director model, recognition, visual understanding, narration) and free-quota enforcement | Not started; these costs are recorded but do not deduct credits. Only paid generation deducts credits today | D-03 |
| Content moderation port (after upload, before and after generation, before export) | Not started | D-05 |
| Error reporting port | Not started | D-07 |
| Scheduler sample for retention cleanup and event delivery | Not started (the commands exist) | Nothing; can be done on request |
| Production bootstrap command for operations-console admins | Not built (only test helpers create operators) | I-13 |
| Export without the visible AI label on user request (agreement clause and 6-month logs) | Not built | D-11 |
| C2PA content credentials; integrity hashes in `AIGC` `ReservedCode1/2`; XMP metadata | Not built; the `AIGC` field and the visible badge (English "AI-generated" by default, Chinese "AI生成" for a Chinese interface) are built and verified | L-04 |
| Mainland China real-time voice provider (region routing) | Not planned (D-01: no mainland China) | — |
| Elorian video understanding | Not started | K-10 |
| Export of editable project files (Premiere / CapCut) | Not scheduled | Your priority call |
| Autonomous production phase 2: AI confirms paid generation under the "full authority" tier, concurrent production, fill shots (AP-06 to AP-15, milestones V6-10 and V6-11) | Planned | Nothing; next in the roadmap |
| CutPrior learning from human editors (AP-16 to AP-18, AP-21) | Paused | M-03 |
| Automatic sound effects for effects; generated elements with transparency that track objects (V6-8 remainder) | Not built | Provider choice for sound effects and alpha-channel generation |
| Editor presence: cursor pointing at specific clips on the timeline; autonomous progress card on the canvas (it is in the chat column today) | Not built | Nothing |
| Retired V4 script/storyboard pipeline on real providers | Not planned (off in production) | D-14 |
| Real-provider verification still outstanding: Claude evaluations, Deepgram (batch and streaming), Fish Audio, HeyGen, Veo, Seedance, Runway generation | Code ready; real runs pending | C-01 to C-03 and the keys in section 5 |
