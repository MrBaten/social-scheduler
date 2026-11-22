import type { Platform, TargetStatus } from "@/lib/types";
import { PLATFORM_UI } from "./platforms";
import { STATUS_CLASSES } from "./StatusPill";

/** Square letter badge in the platform colour (no brand logos). */
export function PlatformIcon({ platform, size = "md" }: { platform: Platform; size?: "sm" | "md" | "lg" }) {
  const ui = PLATFORM_UI[platform];
  const dims = size === "sm" ? "h-5 w-5 text-[9px]" : size === "lg" ? "h-10 w-10 text-sm" : "h-7 w-7 text-[11px]";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-bold text-white ${dims}`}
      style={{ backgroundColor: ui?.color ?? "#6b7280" }}
      aria-hidden="true"
    >
      {ui?.short ?? "?"}
    </span>
  );
}

/**
 * Platform name with a coloured dot. When `status` is given the pill is tinted by
 * target status (pending gray, publishing blue, published green, failed red).
 */
export function PlatformBadge({
  platform,
  status,
  label,
  className = "",
}: {
  platform: Platform;
  status?: TargetStatus;
  label?: string;
  className?: string;
}) {
  const ui = PLATFORM_UI[platform];
  const tone = status ? STATUS_CLASSES[status] : "bg-white text-gray-700 border-gray-200";
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${tone} ${className}`}
      title={status ? `${ui?.label ?? platform}: ${status}` : ui?.label}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: ui?.color ?? "#6b7280" }} aria-hidden="true" />
      <span className="truncate">{label ?? ui?.label ?? platform}</span>
      {status && <span className="sr-only">({status})</span>}
    </span>
  );
}
