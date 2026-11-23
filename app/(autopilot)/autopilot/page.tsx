import type { Metadata } from "next";
import { PageHeader } from "@/components/Card";
import { OverviewView } from "@/components/autopilot/OverviewView";

export const metadata: Metadata = { title: "AutoPilot" };

export default function AutopilotOverviewPage() {
  return (
    <>
      <PageHeader title="AutoPilot" description="Watches your news sources and writes posts for you to review." />
      <OverviewView />
    </>
  );
}
