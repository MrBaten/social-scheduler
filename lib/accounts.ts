import { getDb, newId, nowIso } from "./db";
import { decrypt, encrypt } from "./crypto";
import { PublishError, type AccountStatus, type AccountWithTokens, type Provider, type SocialAccountPublic, type SocialAccountRow } from "./types";
import type { ConnectedAccount } from "./platforms/types";
import { getProviderAdapter } from "./platforms";

// Connected social accounts. Tokens are AES-GCM encrypted at rest and only ever decrypted into
// AccountWithTokens for server-side publishing; SocialAccountPublic never carries them.

const PUBLIC_COLUMNS = "id, provider, platform, platform_account_id, display_name, avatar_url, is_demo, status, token_expires_at, created_at";

type PublicRow = Omit<SocialAccountPublic, "is_demo"> & { is_demo: 0 | 1 };

function toPublic(r: PublicRow): SocialAccountPublic {
  return {
    id: r.id,
    provider: r.provider,
    platform: r.platform,
    platform_account_id: r.platform_account_id,
    display_name: r.display_name,
    avatar_url: r.avatar_url,
    is_demo: r.is_demo === 1,
    status: r.status,
    token_expires_at: r.token_expires_at,
    created_at: r.created_at,
  };
}

function toWithTokens(r: SocialAccountRow): AccountWithTokens {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(r.meta_json || "{}");
  } catch {
    meta = {};
  }
  return {
    id: r.id,
    provider: r.provider,
    platform: r.platform,
    platform_account_id: r.platform_account_id,
    display_name: r.display_name,
    access_token: decrypt(r.access_token_enc),
    refresh_token: r.refresh_token_enc ? decrypt(r.refresh_token_enc) : null,
    token_expires_at: r.token_expires_at,
    meta,
    is_demo: r.is_demo === 1,
  };
}

/** Upsert on (user_id, platform, platform_account_id). Returns the saved accounts (no tokens). */
export function saveConnectedAccounts(
  userId: string,
  provider: Provider,
  accts: ConnectedAccount[],
  isDemo: boolean,
): SocialAccountPublic[] {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO social_accounts (id, user_id, provider, platform, platform_account_id, display_name, avatar_url,
      access_token_enc, refresh_token_enc, token_expires_at, scopes, meta_json, is_demo, status, created_at)
    VALUES (@id, @user_id, @provider, @platform, @platform_account_id, @display_name, @avatar_url,
      @access_token_enc, @refresh_token_enc, @token_expires_at, @scopes, @meta_json, @is_demo, 'active', @created_at)
    ON CONFLICT (user_id, platform, platform_account_id) DO UPDATE SET
      provider = excluded.provider,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      access_token_enc = excluded.access_token_enc,
      -- Keep an existing refresh token if the provider didn't send a new one.
      refresh_token_enc = COALESCE(excluded.refresh_token_enc, social_accounts.refresh_token_enc),
      token_expires_at = excluded.token_expires_at,
      scopes = excluded.scopes,
      meta_json = excluded.meta_json,
      is_demo = excluded.is_demo,
      status = 'active'
  `);
  const select = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM social_accounts WHERE user_id = ? AND platform = ? AND platform_account_id = ?`);

  const tx = db.transaction((list: ConnectedAccount[]) => {
    const out: SocialAccountPublic[] = [];
    for (const a of list) {
      upsert.run({
        id: newId("sa_"),
        user_id: userId,
        provider,
        platform: a.platform,
        platform_account_id: a.platform_account_id,
        display_name: a.display_name,
        avatar_url: a.avatar_url,
        access_token_enc: encrypt(a.access_token),
        refresh_token_enc: a.refresh_token ? encrypt(a.refresh_token) : null,
        token_expires_at: a.token_expires_at,
        scopes: a.scopes,
        meta_json: JSON.stringify(a.meta ?? {}),
        is_demo: isDemo ? 1 : 0,
        created_at: nowIso(),
      });
      out.push(toPublic(select.get(userId, a.platform, a.platform_account_id) as PublicRow));
    }
    return out;
  });
  return tx(accts);
}

export function listAccounts(userId: string): SocialAccountPublic[] {
  const rows = getDb()
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM social_accounts WHERE user_id = ? ORDER BY platform, display_name`)
    .all(userId) as PublicRow[];
  return rows.map(toPublic);
}

export function getAccountWithTokens(userId: string, accountId: string): AccountWithTokens | null {
  const row = getDb().prepare("SELECT * FROM social_accounts WHERE id = ? AND user_id = ?").get(accountId, userId) as
    | SocialAccountRow
    | undefined;
  return row ? toWithTokens(row) : null;
}

export function markAccountStatus(accountId: string, status: AccountStatus): void {
  getDb().prepare("UPDATE social_accounts SET status = ? WHERE id = ?").run(status, accountId);
}

export function deleteAccount(userId: string, accountId: string): boolean {
  return getDb().prepare("DELETE FROM social_accounts WHERE id = ? AND user_id = ?").run(accountId, userId).changes > 0;
}

const REFRESH_WINDOW_MS = 10 * 60_000;

/**
 * Returns the account with a token that's good for at least ~10 more minutes when possible.
 * - Demo accounts and tokens with no expiry (Meta Page tokens) are returned as-is.
 * - Expiring within 10 min + adapter.refresh + refresh token -> refresh and persist.
 * - Refresh rejected by the provider, or token already expired with no way to refresh ->
 *   mark 'expired' and throw PublishError(nonretryable, tokenExpired).
 * - Network/5xx during refresh -> rethrow the retryable PublishError (try again later).
 * - Expiring soon but still valid and not refreshable -> returned as-is (still usable).
 */
export async function ensureFreshToken(userId: string, accountId: string): Promise<AccountWithTokens> {
  // Serialize per account within this process: the scheduler publishes up to 5 targets in
  // parallel, and two concurrent refreshes with a rotating refresh token (TikTok) would make the
  // second one fail with invalid_grant and wrongly mark the account expired.
  const prev = refreshLocks.get(accountId);
  const run = (prev ?? Promise.resolve()).catch(() => {}).then(() => ensureFreshTokenUnlocked(userId, accountId));
  const settled: Promise<void> = run.then(
    () => {},
    () => {},
  );
  refreshLocks.set(accountId, settled);
  void settled.then(() => {
    if (refreshLocks.get(accountId) === settled) refreshLocks.delete(accountId);
  });
  return run;
}

const refreshLocks = new Map<string, Promise<void>>();

async function ensureFreshTokenUnlocked(userId: string, accountId: string): Promise<AccountWithTokens> {
  const acct = getAccountWithTokens(userId, accountId);
  if (!acct) throw new PublishError("Account not found (was it disconnected?)", false);
  if (acct.is_demo) return acct;

  const row = getDb().prepare("SELECT status FROM social_accounts WHERE id = ?").get(accountId) as { status: AccountStatus };
  if (row.status === "expired") throw new PublishError("Account token expired. Reconnect account", false, true);

  if (!acct.token_expires_at) return acct;
  const expiresAt = Date.parse(acct.token_expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt - Date.now() > REFRESH_WINDOW_MS) return acct;

  const adapter = getProviderAdapter(acct.provider);
  const alreadyExpired = expiresAt <= Date.now();
  if (!adapter.refresh || !acct.refresh_token) {
    if (!alreadyExpired) return acct;
    markAccountStatus(accountId, "expired");
    throw new PublishError("Account token expired. Reconnect account", false, true);
  }

  try {
    const r = await adapter.refresh(acct);
    getDb()
      .prepare(
        `UPDATE social_accounts SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc),
         token_expires_at = ?, status = 'active' WHERE id = ?`,
      )
      .run(encrypt(r.access_token), r.refresh_token ? encrypt(r.refresh_token) : null, r.token_expires_at, accountId);
    return getAccountWithTokens(userId, accountId)!;
  } catch (err) {
    if (err instanceof PublishError && err.retryable) throw err;
    markAccountStatus(accountId, "expired");
    const msg = err instanceof Error ? err.message : String(err);
    throw new PublishError(`Token refresh failed (${msg}). Reconnect account`, false, true);
  }
}
