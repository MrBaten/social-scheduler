import { getDb, nowIso } from "../db";
import { pkcePair, randomToken } from "../crypto";
import { PROVIDERS, type Provider } from "../types";

// OAuth `state` (+ PKCE verifier) storage in oauth_states. States are single-use, bound to the
// logged-in user and valid for 15 minutes.

export const STATE_TTL_MS = 15 * 60_000;

export function parseProvider(p: string): Provider | null {
  return (PROVIDERS as string[]).includes(p) ? (p as Provider) : null;
}

export function createOAuthState(userId: string, provider: Provider, usePkce: boolean): { state: string; codeChallenge?: string } {
  const db = getDb();
  // Opportunistic cleanup of stale states.
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(new Date(Date.now() - STATE_TTL_MS).toISOString());
  const state = randomToken(24);
  const pkce = usePkce ? pkcePair() : null;
  db.prepare("INSERT INTO oauth_states (state, user_id, provider, code_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run(
    state,
    userId,
    provider,
    pkce?.verifier ?? null,
    nowIso(),
  );
  return { state, codeChallenge: pkce?.challenge };
}

export type ConsumeResult = { ok: true; codeVerifier: string | null } | { ok: false; error: string };

/** Validates and deletes the state (single use, even when invalid for this user/provider). */
export function consumeOAuthState(state: string | null, userId: string, provider: Provider): ConsumeResult {
  if (!state) return { ok: false, error: "Missing OAuth state" };
  const db = getDb();
  const row = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state) as
    | { state: string; user_id: string; provider: string; code_verifier: string | null; created_at: string }
    | undefined;
  if (!row) return { ok: false, error: "Invalid or already-used OAuth state. Please try connecting again." };
  if (row.user_id !== userId) return { ok: false, error: "OAuth state doesn't belong to this session" };
  db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
  if (row.provider !== provider) return { ok: false, error: "OAuth state was issued for a different provider" };
  if (Date.now() - Date.parse(row.created_at) > STATE_TTL_MS) return { ok: false, error: "Connection request expired. Please try again." };
  return { ok: true, codeVerifier: row.code_verifier };
}
