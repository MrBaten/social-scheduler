import type { Metadata } from "next";
import { PageHeader } from "@/components/Card";
import { NewAutopilotWizard } from "@/components/autopilot/NewAutopilotWizard";

export const metadata: Metadata = { title: "New autopilot" };

export default function NewAutopilotPage() {
  return (
    <>
      <PageHeader title="New autopilot" description="Five steps: niche, sources, templates, accounts and schedule, approval." />
      <NewAutopilotWizard />
    </>
  );
}
