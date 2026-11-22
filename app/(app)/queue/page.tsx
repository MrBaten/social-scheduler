import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses } from "@/components/Button";
import { PageHeader } from "@/components/Card";
import { QueueView } from "@/components/QueueView";

export const metadata: Metadata = { title: "Queue" };

export default function QueuePage() {
  return (
    <>
      <PageHeader
        title="Queue"
        description="Everything scheduled, publishing and published — with live per-platform status."
        actions={
          <Link href="/compose" className={buttonClasses("primary")}>
            New post
          </Link>
        }
      />
      <QueueView />
    </>
  );
}
