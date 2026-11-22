"use client";

import { useEffect, useState } from "react";
import { Button, type ButtonSize } from "./Button";

/**
 * Inline two-step confirmation (no window.confirm). First click arms it; second click
 * runs `onConfirm`. Disarms automatically after a few seconds or via Cancel.
 */
export function ConfirmButton({
  label,
  confirmLabel = "Confirm",
  onConfirm,
  size = "sm",
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
  size?: ButtonSize;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!armed || busy) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed, busy]);

  if (!armed) {
    return (
      <Button variant="secondary" size={size} disabled={disabled} onClick={() => setArmed(true)} className="text-red-700">
        {label}
      </Button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Button
        variant="danger"
        size={size}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setArmed(false);
          }
        }}
      >
        {confirmLabel}
      </Button>
      <Button variant="ghost" size={size} disabled={busy} onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </span>
  );
}
