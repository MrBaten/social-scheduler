import type { Metadata } from "next";
import { SourcesView } from "@/components/autopilot/SourcesView";

export const metadata: Metadata = { title: "Sources · AutoPilot" };

export default async function SourcesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SourcesView id={id} />;
}
