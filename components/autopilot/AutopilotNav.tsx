"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppSwitcher, Avatar, Brand, useLogout } from "../AppNav";

const NAV = [
  { href: "/autopilot", label: "Overview", exact: true },
  { href: "/autopilot/new", label: "New autopilot", exact: true },
];

function isActive(pathname: string, href: string, exact: boolean) {
  if (href === "/autopilot") return pathname === "/autopilot" || (/^\/autopilot\/(?!new)/.test(pathname));
  return exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");
}

export function AutopilotSidebar({ userName, userEmail }: { userName: string; userEmail: string }) {
  const pathname = usePathname() ?? "";
  const { logout, busy } = useLogout();
  return (
    <div className="flex h-full flex-col">
      <Brand />
      <AppSwitcher className="mt-4" />
      <nav className="mt-6 flex flex-col gap-1" aria-label="AutoPilot">
        {NAV.map(({ href, label, exact }) => {
          const active = isActive(pathname, href, exact);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active ? "bg-violet-50 text-violet-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-violet-500" : "bg-gray-300"}`} aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </nav>
      <p className="mt-6 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800">
        Phase 1: AutoPilot writes drafts only. Nothing publishes without your approval.
      </p>
      <div className="mt-auto border-t border-gray-200 pt-4">
        <div className="flex items-center gap-3 px-1">
          <Avatar name={userName} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-900">{userName}</p>
            <p className="truncate text-xs text-gray-500">{userEmail}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={logout}
          disabled={busy}
          className="mt-3 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
        >
          {busy ? "Logging out…" : "Logout"}
        </button>
      </div>
    </div>
  );
}

export function AutopilotTopNav({ userName }: { userName: string }) {
  const pathname = usePathname() ?? "";
  const { logout, busy } = useLogout();
  return (
    <div>
      <div className="flex items-center justify-between">
        <Brand />
        <div className="flex items-center gap-2">
          <Avatar name={userName} />
          <button
            type="button"
            onClick={logout}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
          >
            Logout
          </button>
        </div>
      </div>
      <AppSwitcher className="mt-3" />
      <nav className="mt-3 flex gap-1 overflow-x-auto" aria-label="AutoPilot">
        {NAV.map(({ href, label, exact }) => {
          const active = isActive(pathname, href, exact);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${active ? "bg-violet-50 text-violet-700" : "text-gray-600 hover:bg-gray-100"}`}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
