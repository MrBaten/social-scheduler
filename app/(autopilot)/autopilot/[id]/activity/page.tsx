import type { Metadata } from "next";
import { ActivityView } from "@/components/autopilot/ActivityView";

export const metadata: Metadata = { title: "Activity · AutoPilot" };

export default async function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ActivityView id={id} />;
}
