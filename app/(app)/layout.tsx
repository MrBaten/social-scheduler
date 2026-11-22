import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/auth";
import { SidebarNav, TopNav } from "@/components/AppNav";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen md:flex">
      <aside className="hidden w-60 shrink-0 border-r border-gray-200 bg-white px-4 py-6 md:sticky md:top-0 md:block md:h-screen">
        <SidebarNav userName={user.name} userEmail={user.email} />
      </aside>
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur md:hidden">
        <TopNav userName={user.name} />
      </header>
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 md:py-10 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
