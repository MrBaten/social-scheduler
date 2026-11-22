import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { config, oauthRedirectUri } from "@/lib/config";
import { saveConnectedAccounts } from "@/lib/accounts";
import { getProviderAdapter } from "@/lib/platforms";
import { consumeOAuthState, parseProvider } from "@/lib/platforms/oauth";
import { sanitizeError } from "@/lib/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ provider: string }> };

const redirect = (path: string) => NextResponse.redirect(`${config.appUrl}${path}`, 302);
const fail = (msg: string, provider?: string) =>
  redirect(`/accounts?error=${encodeURIComponent(msg.slice(0, 300))}${provider ? `&provider=${provider}` : ""}`);

export async function GET(request: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return redirect(`/login?next=${encodeURIComponent("/accounts")}`);

  const provider = parseProvider((await ctx.params).provider);
  if (!provider) return fail("Unknown provider");

  const q = new URL(request.url).searchParams;
  // Validate (and burn) the state first, even when the provider reports an error.
  const st = consumeOAuthState(q.get("state"), user.id, provider);

  const providerError = q.get("error");
  if (providerError) {
    // e.g. Meta: error=access_denied&error_reason=user_denied; Google/LinkedIn/TikTok: error_description
    const desc = q.get("error_description") || q.get("error_reason") || providerError;
    return fail(providerError === "access_denied" || providerError === "user_cancelled" ? "Connection was cancelled" : desc, provider);
  }
  if (!st.ok) return fail(st.error, provider);

  const code = q.get("code");
  if (!code) return fail("Missing authorization code", provider);

  try {
    const adapter = getProviderAdapter(provider);
    const accounts = await adapter.exchangeCode({
      code,
      redirectUri: oauthRedirectUri(provider),
      codeVerifier: st.codeVerifier ?? undefined,
    });
    if (accounts.length === 0) return fail("No accounts were found to connect", provider);
    saveConnectedAccounts(user.id, provider, accounts, false);
    return redirect(`/accounts?connected=${provider}`);
  } catch (err) {
    // Log the sanitized message only (no error object / cause chain that could carry tokens).
    const msg = sanitizeError(err instanceof Error ? err.message : String(err));
    console.error(`[oauth:${provider}] callback failed: ${msg}`);
    return fail(err instanceof Error ? msg : "Connection failed", provider);
  }
}
