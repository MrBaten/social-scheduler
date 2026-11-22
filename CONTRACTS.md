# Build contracts (for parallel builders)

Stack: Next.js 16 (App Router, Route Handlers, `params` is a Promise, `cookies()` is async),
React 19, TypeScript strict, Tailwind v4 (`@import "tailwindcss"` already in app/globals.css),
better-sqlite3 (sync API), zod, bcryptjs, vitest. Do NOT add `middleware.ts`/`proxy.ts`; check auth
inside pages/route handlers. Do NOT edit files you don't own; if you need something from another
owner, code against the signature below. Do NOT run `npm install` for new deps without need; if you
must, list them in your report. Path alias `@/` = repo root.

Already written (read-only for everyone): `lib/types.ts`, `lib/db.ts`, `lib/crypto.ts`,
`lib/config.ts`, `lib/auth.ts`, `lib/api.ts`, `lib/platforms/types.ts`.

## Concept
- Operator (app owner) registers ONE developer app per provider and puts keys in `.env`.
- End users click **Connect** on /accounts -> OAuth -> accounts saved (tokens AES-GCM encrypted).
- **Demo mode**: if a provider has no keys (or `DEMO_MODE=true`), Connect creates simulated
  accounts and publishing is simulated (no network). Text containing `#fail` makes a demo
  publish throw a retryable PublishError; `#fatal` throws non-retryable. This lets the whole
  flow run locally with zero keys.
- Meta connect yields Facebook Pages + linked Instagram business accounts. Google -> YouTube.

## Owner A — UI (`app/(app)/**`, `app/login/**`, `app/signup/**`, `app/layout.tsx`, `app/page.tsx`, `components/**`)
Pages: `/login`, `/signup`, `/` (redirect to /compose or /login), `/compose` (composer),
`/queue` (list + calendar-ish week view of posts with per-target status), `/accounts`
(connect buttons per provider with "Demo" badge when demo, list connected accounts, disconnect),
`/posts/[id]` (detail: per-target status, errors, links, retry button, delete).
Consumes ONLY the HTTP API below (client components use fetch). Server components may call
`getCurrentUser()` to redirect unauthenticated users to /login.

## Owner B — Providers & adapters (`lib/platforms/**` except types.ts, `lib/accounts.ts`, `app/api/oauth/**`, `app/api/accounts/**`, `app/api/providers/**`)
Must export from `lib/platforms/index.ts`:
```ts
export function getProviderAdapter(p: Provider): ProviderAdapter;
export function getPublisher(p: Platform): PlatformPublisher;   // real publisher; demo handled below
export const PLATFORM_RULES: Record<Platform, PlatformRules>;
export function validateForPlatform(p: Platform, c: PublishContent): string[];
/** Publish choosing demo vs real by account.is_demo. */
export function publishTo(account: AccountWithTokens, c: PublishContent): Promise<PublishResult>;
export function demoAccountsFor(p: Provider, userName: string): ConnectedAccount[];
```
Must export from `lib/accounts.ts`:
```ts
export function saveConnectedAccounts(userId: string, provider: Provider, accts: ConnectedAccount[], isDemo: boolean): SocialAccountPublic[]; // upsert on (user_id, platform, platform_account_id)
export function listAccounts(userId: string): SocialAccountPublic[];
export function getAccountWithTokens(userId: string, accountId: string): AccountWithTokens | null;
/** Refresh if token expires within 10 min and provider supports refresh; persists result. Returns fresh account. Marks status 'expired' and throws PublishError(nonretryable, tokenExpired) if refresh impossible. */
export function ensureFreshToken(userId: string, accountId: string): Promise<AccountWithTokens>;
export function markAccountStatus(accountId: string, status: AccountStatus): void;
export function deleteAccount(userId: string, accountId: string): boolean;
```
HTTP:
- `GET  /api/providers` -> `{ providers: { provider, label, platforms, demo: boolean }[] }`
- `GET  /api/oauth/[provider]/start` -> 302 to provider auth URL (state+PKCE stored in oauth_states), or in demo mode directly saves demo accounts and 302s to `/accounts?connected=<provider>`.
- `GET  /api/oauth/[provider]/callback` -> validates state (belongs to current user, < 15 min old, single-use), exchanges code, saves, 302 `/accounts?connected=<provider>` or `/accounts?error=...`.
- `GET  /api/accounts` -> `{ accounts: SocialAccountPublic[] }`
- `DELETE /api/accounts/[id]` -> `{ ok: true }`
Real adapters: Meta Graph (FB Page feed/photos/videos; IG container create -> poll status -> media_publish, feed/reel/story, carousel up to 10), LinkedIn (OpenID userinfo for member, w_member_social; Posts API `/rest/posts` with images/videos via Images/Videos API; org pages if `w_organization_social` granted), YouTube Data API v3 resumable upload (videos.insert, snippet+status), TikTok Content Posting API (creator_info query, Direct Post `/v2/post/publish/video/init/` with PULL_FROM_URL or FILE_UPLOAD, photo posts via `/v2/post/publish/content/init/`, status fetch). Verify current endpoints against official docs (WebFetch) where unsure; note any doubts in code comments.

## Owner C — Posts API, media, auth routes, scheduler (`app/api/auth/**`, `app/api/posts/**`, `app/api/media/**`, `app/api/cron/**`, `lib/posts.ts`, `lib/media.ts`, `lib/scheduler.ts`, `scripts/worker.ts`, `tests/**`)
HTTP:
- `POST /api/auth/signup` `{email,name,password}` -> sets session, `{ user }`
- `POST /api/auth/login` `{email,password}` -> `{ user }` | 401
- `POST /api/auth/logout` -> `{ ok: true }`
- `GET  /api/auth/me` -> `{ user }` | 401
- `POST /api/media` multipart field `file` (image/jpeg,png,webp,gif; video/mp4,quicktime) -> `{ media: { id, public_url, mime_type, filename, size_bytes } }`. Stored in `public/uploads/<id>.<ext>`; public_url = `${config.publicMediaBaseUrl}/uploads/<id>.<ext>`.
- `GET  /api/posts?from=ISO&to=ISO` -> `{ posts: PostWithTargets[] }` (current user only)
- `POST /api/posts` body `CreatePostInput` -> validates each target with `validateForPlatform` (400 with per-target errors `{ errors: { [social_account_id]: string[] } }`), creates post (status `scheduled` if scheduled_at else `draft`), targets `pending` with `next_attempt_at = scheduled_at` -> `{ post: PostWithTargets }`
- `GET/PATCH/DELETE /api/posts/[id]` (PATCH only if no target is publishing/published)
- `POST /api/posts/[id]/retry` -> failed targets back to pending, next_attempt_at=now
- `POST /api/posts/[id]/publish-now` -> sets scheduled_at=now on pending targets & triggers `processDuePosts()`
- `GET|POST /api/cron/publish` -> requires `Authorization: Bearer ${CRON_SECRET}` when CRON_SECRET set -> runs `processDuePosts()` -> `{ processed, published, failed }`
Scheduler (`lib/scheduler.ts`): `processDuePosts(now?: Date): Promise<{processed:number;published:number;failed:number}>`
- atomically claim targets with status pending AND next_attempt_at <= now (set publishing + locked_at); also reclaim targets stuck in publishing with locked_at older than 15 min.
- for each: `ensureFreshToken`, build PublishContent (text_override ?? base_text, media ordered, options), `publishTo`.
- success -> published + ids/url; retryable failure -> attempts+1, backoff 1m,5m,15m,1h, max 4 attempts then failed; non-retryable -> failed; tokenExpired -> failed with message "Reconnect account".
- after each target update, recompute post status: all published -> published; all failed -> failed; mix of published+failed (none pending/publishing) -> partial; any publishing, or any pending target that is retrying (attempts>0) or sits beside published/failed ones -> publishing; else scheduled.
- concurrency: process up to 5 targets in parallel.
`scripts/worker.ts`: loop every 30s calling processDuePosts (for local/VPS). Vercel Cron can hit /api/cron/publish instead.
Tests (vitest, `resetDbForTests()`): scheduler happy path with demo accounts, retry/backoff with `#fail`, `#fatal`, post status rollup, per-user isolation of posts API helpers.
