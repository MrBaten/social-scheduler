import type { ReactNode } from "react";
import { AutopilotHeader } from "@/components/autopilot/AutopilotHeader";

export default async function AutopilotDetailLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <AutopilotHeader id={id} />
      {children}
    </>
  );
}
