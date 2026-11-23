import { redirect } from "next/navigation";

export default async function AutopilotIndex({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/autopilot/${id}/inbox`);
}
