import type { Metadata } from "next";
import { Suspense } from "react";
import { InboxView } from "@/components/autopilot/InboxView";

export const metadata: Metadata = { title: "Review inbox · AutoPilot" };

export default async function InboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
      <InboxView id={id} />
    </Suspense>
  );
}
