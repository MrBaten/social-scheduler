# Social Scheduler

Write one post, publish it to **Facebook, Instagram, LinkedIn, YouTube and TikTok** on a schedule.

- Users click **Connect** and sign in with each platform (OAuth). They never handle API keys.
- The app owner registers **one developer app per platform** once and puts its keys in `.env`.
- Any platform without keys runs in **demo mode**: connecting creates simulated accounts and
  publishing is simulated. So the whole app works locally with zero keys.

Stack: Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, SQLite (better-sqlite3), zod, vitest.

## Run locally (demo mode, no keys)

```bash
npm install
cp .env.example .env.local        # optional in dev
npm run dev                       # http://localhost:3000
npm run worker                    # second terminal: publishes due posts every 30s
```

Sign up → **Accounts** → Connect (demo) → **Compose** → Post now / Schedule.
Add `#fail` to the text to see automatic retries, `#fatal` for a permanent failure.

Tests: `npm test` · Typecheck: `npm run typecheck` · Production build: `npm run build && npm start`
(production requires `ENCRYPTION_KEY` and `APP_URL`).

## How it works

| Part | Where |
|---|---|
| UI: compose, queue/calendar, accounts, post detail | `app/(app)/*`, `components/*` |
| Auth (email + password, server sessions) | `lib/auth.ts`, `app/api/auth/*` |
| OAuth connect + encrypted token storage (AES-256-GCM) | `app/api/oauth/[provider]/*`, `lib/accounts.ts`, `lib/crypto.ts` |
| Platform adapters | `lib/platforms/{meta,linkedin,google,tiktok}.ts`, rules in `rules.ts` |
| Posts + validation | `lib/posts.ts`, `app/api/posts/*` |
| Scheduler (atomic claim, retries 1m/5m/15m, max 4 attempts, heartbeat) | `lib/scheduler.ts` |
| Runs the scheduler | `scripts/worker.ts`, or `RUN_WORKER_IN_PROCESS=true`, or cron → `/api/cron/publish` |
| Media (served publicly at `/uploads/<id>.<ext>` so platforms can fetch it) | `lib/media.ts`, `app/uploads/[name]/route.ts` |

## Deploy on Railway (single service)

1. New service from this GitHub repo. Add a **Volume** mounted at `/data`.
2. Variables:
   `APP_URL=https://<your-app>.up.railway.app`, `ENCRYPTION_KEY=<openssl rand -base64 32>`,
   `CRON_SECRET=<random>`, `RUN_WORKER_IN_PROCESS=true`,
   `DATABASE_PATH=/data/app.db`, `UPLOADS_DIR=/data/uploads`.
3. Build `npm run build`, start `npm start` (Railway detects these automatically).

## Going live per platform

Every OAuth redirect/callback URL is `${APP_URL}/api/oauth/<provider>/callback`.

**Meta (Facebook + Instagram)**: provider `meta`
1. developers.facebook.com → Create app (Business type) → add **Facebook Login for Business** (or Facebook Login).
2. Valid OAuth Redirect URI: `${APP_URL}/api/oauth/meta/callback`.
3. Permissions used: `pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, business_management`.
4. While the app is in **Development mode**, people with a role on the app (admin/developer/tester) can grant these
   permissions without App Review. That's enough for a real test on your own Pages. Public users need **App Review**.
5. Instagram must be a **Business/Creator** account linked to a Facebook Page. Images must be JPEG, and media must be
   reachable at a public URL (`APP_URL`).
6. Set `META_APP_ID`, `META_APP_SECRET`.
7. If the app uses **Facebook Login for Business** (Business-type apps do), create a configuration under
   Facebook Login for Business → Configurations (token type: *User access token*; permissions as above) and set
   `META_LOGIN_CONFIG_ID` to its ID. The login dialog then sends `config_id` instead of a scope list.

**LinkedIn**: provider `linkedin`
Create an app → add products **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn** → add the redirect
URL → set `LINKEDIN_CLIENT_ID/SECRET`. Company pages need the Community Management API (`LINKEDIN_ORG_POSTING=true`).

**Google / YouTube**: provider `google`
Google Cloud project → enable **YouTube Data API v3** → OAuth consent screen → OAuth client (Web) with the redirect URL →
set `GOOGLE_CLIENT_ID/SECRET`. Unverified apps' uploads are locked to private until Google verifies the app.

**TikTok**: provider `tiktok`
developers.tiktok.com → app with **Login Kit** + **Content Posting API** (Direct Post) → redirect URL → set
`TIKTOK_CLIENT_KEY/SECRET`. Until TikTok audits the app, posts are private (`SELF_ONLY`), the account must be private,
and at most 5 users per 24h can post.

## AutoPilot (auto post creation, Phase 1)

A separate module at **/autopilot** (switch with *Scheduler | AutoPilot* in the sidebar). Same login, accounts and
queue. It watches free news sources (RSS/Atom feeds, Google News RSS searches, GDELT), groups coverage of the same story,
scores it against your niche, and writes per-platform drafts (Facebook, Instagram, LinkedIn) into a **Review inbox**.
**Approve** turns a draft into a normal post in the Queue (with an *AutoPilot* badge); the existing scheduler publishes it.
Nothing is posted without your approval in Phase 1.

| Part | Where |
|---|---|
| Screens: Overview, New autopilot wizard, Inbox, Sources, Templates, Activity, Settings | `app/(autopilot)/*`, `components/autopilot/*` |
| API | `app/api/autopilot/*` |
| Tables `autopilots`, `ap_sources`, `ap_items`, `ap_topics`, `ap_templates`, `ap_drafts`, `ap_runs`, `ap_settings` + `posts.origin`, `posts.ap_draft_id` | `lib/autopilot/schema.ts` (auto-migrates on start) |
| Pipeline: ingest → exact dedupe → story grouping → relevance → pick topic for open slot → generate | `lib/autopilot/{ingest,relevance,pipeline,generate}.ts` |
| Source adapters (add Feedly etc. here) | `lib/autopilot/sources.ts` |
| AI providers | `lib/autopilot/ai.ts` |
| Approve → queue hand-off | `lib/autopilot/handoff.ts` |
| Worker loop (`RUN_AUTOPILOT=true`, separate from the publisher) | `lib/autopilot/worker.ts`, started in `instrumentation.ts` |

Variables: `RUN_AUTOPILOT`, `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` (see `.env.example`). Without
`AI_API_KEY` drafts are filled straight from the template and flagged *No AI*.

Phase 1 limits: story grouping uses word overlap (no embeddings yet); quality checks are basic flags (no AI review score);
no image cards, so Instagram is included only when you attach an image at approval; Assisted / Full-auto modes are Phase 3.

## Known limits (demo build)

- SQLite + local disk: one server instance. For scale, move to Postgres (e.g. Supabase) and object storage.
- Login/signup are rate-limited in memory (per server). Close sign-ups with `SIGNUP_ENABLED=false`
  or restrict to `ALLOWED_EMAILS`.
- Deleting posts/accounts doesn't delete uploaded files yet.
- Real-API paths are written against current docs but have not yet been run against live platforms.
  Items still marked `// VERIFY:` in `lib/platforms/*` should be confirmed during the first real test.
