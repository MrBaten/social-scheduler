import { config } from "./config";

/** Whether this email may use the app at all (ALLOWED_EMAILS allowlist; empty = everyone). */
export function emailAllowed(email: string): boolean {
  if (!config.allowedEmails.length) return true;
  return config.allowedEmails.includes(email.trim().toLowerCase());
}
