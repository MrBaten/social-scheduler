"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "./api";

const NAV = [
  { href: "/compose", label: "Compose", icon: IconPencil },
  { href: "/queue", label: "Queue", icon: IconCalendar },
  { href: "/accounts", label: "Accounts", icon: IconLink },
];

function useLogout() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    setBusy(true);
    try {
      await api("/api/auth/logout", { method: "POST", noAuthRedirect: true });
    } catch {
      // Even if the call fails, send the user to the login page.
    }
    router.push("/login");
    router.refresh();
  };
  return { logout, busy };
}

function isActive(pathname: string, href: string) {
  if (href === "/queue") return pathname === "/queue" || pathname.startsWith("/posts/");
  return pathname === href || pathname.startsWith(href + "/");
}

/** Vertical sidebar navigation (md and up). */
export function SidebarNav({ userName, userEmail }: { userName: string; userEmail: string }) {
  const pathname = usePathname() ?? "";
  const { logout, busy } = useLogout();
  return (
    <div className="flex h-full flex-col">
      <Brand />
      <nav className="mt-8 flex flex-col gap-1" aria-label="Main">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active ? "bg-indigo-50 text-indigo-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              <Icon />
              {label}
            </Link>
          );
        })}
      </nav>
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
          <IconLogout />
          {busy ? "Logging out…" : "Logout"}
        </button>
      </div>
    </div>
  );
}

/** Compact top bar for small screens. */
export function TopNav({ userName }: { userName: string }) {
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
      <nav className="mt-3 flex gap-1 overflow-x-auto" aria-label="Main">
        {NAV.map(({ href, label }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                active ? "bg-indigo-50 text-indigo-700" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function Brand() {
  return (
    <Link href="/compose" className="flex items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <path d="M4 12h10M10 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M20 5v14" strokeLinecap="round" />
        </svg>
      </span>
      <span className="text-base font-semibold tracking-tight text-gray-900">Social Scheduler</span>
    </Link>
  );
}

function Avatar({ name }: { name: string }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?";
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700" aria-hidden="true">
      {initials}
    </span>
  );
}

function svgProps() {
  return {
    viewBox: "0 0 24 24",
    className: "h-4 w-4",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}
function IconPencil() {
  return (
    <svg {...svgProps()}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function IconCalendar() {
  return (
    <svg {...svgProps()}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}
function IconLink() {
  return (
    <svg {...svgProps()}>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}
function IconLogout() {
  return (
    <svg {...svgProps()}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </svg>
  );
}
