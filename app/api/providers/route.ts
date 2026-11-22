import { handle } from "@/lib/api";
import { isDemoProvider } from "@/lib/config";
import { getProviderAdapter } from "@/lib/platforms";
import { PROVIDER_PLATFORMS, PROVIDERS } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return handle(async () => ({
    providers: PROVIDERS.map((provider) => ({
      provider,
      label: getProviderAdapter(provider).label,
      platforms: PROVIDER_PLATFORMS[provider],
      demo: isDemoProvider(provider),
    })),
  }));
}
