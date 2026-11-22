import type { AccountStatus, PostStatus, TargetStatus } from "@/lib/types";

export type AnyStatus = PostStatus | TargetStatus | AccountStatus;

/** Tailwind classes per status. Target colours: pending gray, publishing blue, published green, failed red. */
export const STATUS_CLASSES: Record<AnyStatus, string> = {
  pending: "bg-gray-100 text-gray-700 border-gray-200",
  publishing: "bg-blue-100 text-blue-800 border-blue-200",
  published: "bg-green-100 text-green-800 border-green-200",
  failed: "bg-red-100 text-red-800 border-red-200",
  draft: "bg-gray-100 text-gray-600 border-gray-200",
  scheduled: "bg-indigo-100 text-indigo-800 border-indigo-200",
  partial: "bg-amber-100 text-amber-800 border-amber-200",
  active: "bg-green-100 text-green-800 border-green-200",
  expired: "bg-amber-100 text-amber-800 border-amber-200",
  error: "bg-red-100 text-red-800 border-red-200",
};

const DOT: Record<AnyStatus, string> = {
  pending: "bg-gray-400",
  publishing: "bg-blue-500 animate-pulse",
  published: "bg-green-500",
  failed: "bg-red-500",
  draft: "bg-gray-400",
  scheduled: "bg-indigo-500",
  partial: "bg-amber-500",
  active: "bg-green-500",
  expired: "bg-amber-500",
  error: "bg-red-500",
};

export function StatusPill({ status, className = "" }: { status: AnyStatus; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${STATUS_CLASSES[status] ?? STATUS_CLASSES.pending} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[status] ?? DOT.pending}`} aria-hidden="true" />
      {status}
    </span>
  );
}
