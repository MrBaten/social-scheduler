import type { Metadata } from "next";
import { SettingsView } from "@/components/autopilot/SettingsView";

export const metadata: Metadata = { title: "Settings · AutoPilot" };

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SettingsView id={id} />;
}
