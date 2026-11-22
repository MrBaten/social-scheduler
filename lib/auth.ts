import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getDb, newId, nowIso } from "./db";
import { randomToken, sha256 } from "./crypto";
import type { User } from "./types";

// Minimal email/password auth with server-side sessions (cookie holds a random token,
// DB stores only its SHA-256). Swap for Supabase Auth when moving to production.

export const SESSION_COOKIE = "ss_session";
const SESSION_DAYS = 30;

export class AuthError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
  }
}

export async function createUser(email: string, name: string, password: string): Promise<User> {
  const db = getDb();
  const normEmail = email.trim().toLowerCase();
  const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(normEmail);
  if (exists) throw new AuthError("Email already registered");
  const user: User = { id: newId("u_"), email: normEmail, name: name.trim() || normEmail, created_at: nowIso() };
  const hash = await bcrypt.hash(password, 10);
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
    user.id, user.email, user.name, hash, user.created_at,
  );
  return user;
}

let dummyHash: Promise<string> | null = null;

export async function verifyLogin(email: string, password: string): Promise<User | null> {
  const row = getDb()
    .prepare("SELECT id, email, name, password_hash, created_at FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as (User & { password_hash: string }) | undefined;
  if (!row) {
    // Same cost as a real check, so response time doesn't reveal which emails are registered.
    await bcrypt.compare(password, await (dummyHash ??= bcrypt.hash("dummy-password-for-timing", 10)));
    return null;
  }
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return null;
  const { password_hash: _ignored, ...user } = row;
  return user;
}

/** Creates a session and sets the cookie. Call from a Route Handler or Server Action. */
export async function startSession(userId: string): Promise<void> {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  getDb().prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    sha256(token), userId, expires.toISOString(),
  );
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  jar.delete(SESSION_COOKIE);
}

/** Returns the logged-in user or null. Works in Server Components and Route Handlers. */
export async function getCurrentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT u.id, u.email, u.name, u.created_at, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as (User & { expires_at: string }) | undefined;
  if (!row || row.expires_at < nowIso()) return null;
  const { expires_at: _e, ...user } = row;
  return user;
}

/** Throws AuthError if not logged in. Use in Route Handlers; catch -> 401. */
export async function requireUser(): Promise<User> {
  const u = await getCurrentUser();
  if (!u) throw new AuthError();
  return u;
}
