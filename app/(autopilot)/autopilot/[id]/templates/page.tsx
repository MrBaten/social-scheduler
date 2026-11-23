import type { Metadata } from "next";
import { TemplatesView } from "@/components/autopilot/TemplatesView";

export const metadata: Metadata = { title: "Templates · AutoPilot" };

export default async function TemplatesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TemplatesView id={id} />;
}
