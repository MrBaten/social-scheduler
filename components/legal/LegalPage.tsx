import Link from "next/link";
import type { ReactNode } from "react";

export const LEGAL = {
  appName: "Social Scheduler (PostPilot)",
  operator: "Md Abu Baten",
  location: "Dhaka, Bangladesh",
  email: "baten.nub@gmail.com",
  updated: "23 November 2026",
};

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <nav className="mb-8 flex flex-wrap gap-4 text-sm text-indigo-600">
        <Link href="/login">Sign in</Link>
        <Link href="/privacy">Privacy Policy</Link>
        <Link href="/terms">Terms of Service</Link>
        <Link href="/data-deletion">Data Deletion</Link>
      </nav>
      <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {LEGAL.updated}</p>
      <div className="legal mt-8 space-y-5 leading-relaxed text-gray-800 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
        {children}
      </div>
    </main>
  );
}
