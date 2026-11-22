import type { Metadata } from "next";
import { PageHeader } from "@/components/Card";
import { Composer } from "@/components/Composer";

export const metadata: Metadata = { title: "Compose" };

export default function ComposePage() {
  return (
    <>
      <PageHeader title="Compose" description="Create one post and publish it to every connected platform." />
      <Composer />
    </>
  );
}
