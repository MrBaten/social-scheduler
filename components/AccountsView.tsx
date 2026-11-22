"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Platform, Provider, SocialAccountPublic } from "@/lib/types";
import { PLATFORMS, PROVIDER_PLATFORMS } from "@/lib/types";
import { api, formatLocal } from "./api";
import { buttonClasses, Spinner } from "./Button";
import { Alert, Card, DemoBadge } from "./Card";
import { ConfirmButton } from "./ConfirmButton";
import { PlatformBadge, PlatformIcon } from "./PlatformBadge";
import { PLATFORM_UI, PROVIDER_UI } from "./platforms";
import { StatusPill } from "./StatusPill";

interface ProviderInfo {
  provider: Provider;
  label: string;
  platforms: Platform[];
  demo: boolean;
}

function providerLabel(p: string, providers: ProviderInfo[] | null) {
  return providers?.find((x) => x.provider === p)?.label ?? PROVIDER_UI[p as Provider]?.label ?? p;
}

export function AccountsView() {
  const router = useRouter();
  const params = useSearchParams();
  const connected = params.get("connected");
  const errorParam = params.get("error");

  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [accounts, setAccounts] = useState<SocialAccountPublic[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const loadAccounts = useCallback(async () => {
    try {
      const r = await api<{ accounts: SocialAccountPublic[] }>("/api/accounts");
      setAccounts(r.accounts ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load accounts");
    }
  }, []);

  useEffect(() => {
    api<{ providers: ProviderInfo[] }>("/api/providers")
      .then((r) => setProviders(r.providers ?? []))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : "Could not load providers"));
    void loadAccounts();
  }, [loadAccounts]);

  async function disconnect(id: string) {
    setActionError(null);
    try {
      await api(`/api/accounts/${id}`, { method: "DELETE" });
      setAccounts((prev) => (prev ?? []).filter((a) => a.id !== id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not disconnect");
    }
  }

  function dismissBanner() {
    setDismissed(true);
    router.replace("/accounts", { scroll: false });
  }

  const sortedAccounts = (accounts ?? [])
    .slice()
    .sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) || a.display_name.localeCompare(b.display_name));

  return (
    <div className="space-y-8">
      {!dismissed && connected && (
        <Alert tone="success" className="flex items-start justify-between gap-3">
          <span>
            <span className="font-semibold">{providerLabel(connected, providers)}</span> connected. Your accounts are listed below.
          </span>
          <button type="button" onClick={dismissBanner} className="text-green-700 hover:text-green-900" aria-label="Dismiss">
            ✕
          </button>
        </Alert>
      )}
      {!dismissed && errorParam && (
        <Alert tone="error" className="flex items-start justify-between gap-3">
          <span>
            <span className="font-semibold">Connection failed:</span> {errorParam}
          </span>
          <button type="button" onClick={dismissBanner} className="text-red-700 hover:text-red-900" aria-label="Dismiss">
            ✕
          </button>
        </Alert>
      )}
      {loadError && <Alert tone="error">{loadError}</Alert>}
      {actionError && <Alert tone="error">{actionError}</Alert>}

      {/* Providers */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Connect a platform</h2>
        {providers === null ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Spinner /> Loading providers…
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {providers.map((p) => {
              const platforms = p.platforms?.length ? p.platforms : PROVIDER_PLATFORMS[p.provider] ?? [];
              const count = (accounts ?? []).filter((a) => a.provider === p.provider).length;
              return (
                <div key={p.provider} className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex -space-x-1.5">
                      {platforms.map((pl) => (
                        <span key={pl} className="rounded-lg ring-2 ring-white">
                          <PlatformIcon platform={pl} size="lg" />
                        </span>
                      ))}
                    </div>
                    {p.demo && <DemoBadge />}
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-gray-900">{p.label || PROVIDER_UI[p.provider]?.label}</h3>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {platforms.map((pl) => (
                      <PlatformBadge key={pl} platform={pl} />
                    ))}
                  </div>
                  <p className="mt-3 text-sm text-gray-500">{PROVIDER_UI[p.provider]?.blurb}</p>
                  {p.demo && (
                    <p className="mt-2 text-xs text-yellow-800">No API keys configured — connecting creates simulated accounts</p>
                  )}
                  <div className="mt-auto pt-5">
                    {/* Plain <a>: full navigation so the server can 302 to the OAuth provider. */}
                    <a href={`/api/oauth/${p.provider}/start`} className={buttonClasses("primary", "lg", "w-full")}>
                      {count > 0 ? "Connect more" : "Connect"}
                    </a>
                    {count > 0 && <p className="mt-2 text-center text-xs text-gray-500">{count} connected</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Connected accounts */}
      <Card title="Connected accounts" description="Accounts you can publish to." padded={false}>
        {accounts === null ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-gray-500">
            <Spinner /> Loading…
          </div>
        ) : sortedAccounts.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">No accounts connected yet. Use a Connect button above.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {sortedAccounts.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {a.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.avatar_url} alt="" className="h-10 w-10 shrink-0 rounded-full border border-gray-200 object-cover" />
                  ) : (
                    <PlatformIcon platform={a.platform} size="lg" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900">{a.display_name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <PlatformBadge platform={a.platform} />
                      {a.is_demo && <DemoBadge />}
                      <StatusPill status={a.status} />
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <span className="hidden text-xs text-gray-400 lg:inline" title={a.token_expires_at ? `Token expires ${formatLocal(a.token_expires_at)}` : undefined}>
                    Added {formatLocal(a.created_at, { dateStyle: "medium" })}
                  </span>
                  {a.status !== "active" && (
                    <a href={`/api/oauth/${a.provider}/start`} className={buttonClasses("primary", "sm")}>
                      Reconnect
                    </a>
                  )}
                  <ConfirmButton label="Disconnect" confirmLabel="Yes, disconnect" onConfirm={() => disconnect(a.id)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-gray-400">
        Tokens are stored encrypted on the server and never sent to your browser. {PLATFORMS.map((p) => PLATFORM_UI[p].label).join(", ")} are supported.
      </p>
    </div>
  );
}
