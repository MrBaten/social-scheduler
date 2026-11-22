import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { config, isDemoProvider, oauthRedirectUri } from "@/lib/config";
import { saveConnectedAccounts } from "@/lib/accounts";
import { demoAccountsFor, getProviderAdapter } from "@/lib/platforms";
import { createOAuthState, parseProvider } from "@/lib/platforms/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ provider: string }> };

const redirect = (path: string) => NextResponse.redirect(`${config.appUrl}${path}`, 302);

export async function GET(_request: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return redirect(`/login?next=${encodeURIComponent("/accounts")}`);

  const provider = parseProvider((await ctx.params).provider);
  if (!provider) return redirect(`/accounts?error=${encodeURIComponent("Unknown provider")}`);

  if (isDemoProvider(provider)) {
    saveConnectedAccounts(user.id, provider, demoAccountsFor(provider, user.name), true);
    return redirect(`/accounts?connected=${provider}`);
  }

  const adapter = getProviderAdapter(provider);
  const { state, codeChallenge } = createOAuthState(user.id, provider, adapter.usesPkce);
  const url = adapter.getAuthUrl({ state, redirectUri: oauthRedirectUri(provider), codeChallenge });
  return NextResponse.redirect(url, 302);
}
