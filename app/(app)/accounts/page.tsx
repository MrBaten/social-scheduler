import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountsView } from "@/components/AccountsView";
import { PageHeader } from "@/components/Card";

export const metadata: Metadata = { title: "Accounts" };

export default function AccountsPage() {
  return (
    <>
      <PageHeader title="Accounts" description="Connect the social accounts you want to publish to." />
      <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
        <AccountsView />
      </Suspense>
    </>
  );
}
