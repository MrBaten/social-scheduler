"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Autopilot } from "@/lib/autopilot/types";
import { api } from "../api";
import { Button, Spinner } from "../Button";
import { Alert, Card } from "../Card";
import { ConfirmButton } from "../ConfirmButton";
import { ApprovalFields, ProfileFields, ScheduleFields, autopilotPayload, valuesFromAutopilot, type AutopilotFormValues } from "./AutopilotForm";
import { errorText } from "./shared";

export function SettingsView({ id }: { id: string }) {
  const router = useRouter();
  const [ap, setAp] = useState<Autopilot | null>(null);
  const [v, setV] = useState<AutopilotFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "status">(null);

  useEffect(() => {
    api<{ autopilot: Autopilot }>(`/api/autopilot/${id}`)
      .then((r) => {
        setAp(r.autopilot);
        setV(valuesFromAutopilot(r.autopilot));
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [id]);

  const set = <K extends keyof AutopilotFormValues>(k: K, val: AutopilotFormValues[K]) => {
    setSaved(false);
    setV((prev) => (prev ? { ...prev, [k]: val } : prev));
  };

  async function save() {
    if (!v) return;
    if (!v.name.trim()) return setError("Name is required.");
    if (v.window_start >= v.window_end) return setError("The posting window must end after it starts.");
    setBusy("save");
    setError(null);
    try {
      const r = await api<{ autopilot: Autopilot }>(`/api/autopilot/${id}`, { method: "PATCH", json: autopilotPayload(v) });
      setAp(r.autopilot);
      setV(valuesFromAutopilot(r.autopilot));
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(status: "active" | "paused") {
    setBusy("status");
    setError(null);
    try {
      const r = await api<{ autopilot: Autopilot }>(`/api/autopilot/${id}`, { method: "PATCH", json: { status } });
      setAp(r.autopilot);
      router.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    try {
      await api(`/api/autopilot/${id}`, { method: "DELETE" });
      router.push("/autopilot");
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!ap || !v) {
    return error ? (
      <Alert tone="error">{error}</Alert>
    ) : (
      <p className="flex items-center gap-2 py-10 text-sm text-gray-500">
        <Spinner /> Loading…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      <Card
        title="Status"
        actions={
          ap.status === "active" ? (
            <Button variant="secondary" size="sm" loading={busy === "status"} onClick={() => setStatus("paused")}>
              Pause
            </Button>
          ) : (
            <Button size="sm" loading={busy === "status"} onClick={() => setStatus("active")}>
              Resume
            </Button>
          )
        }
      >
        <p className="text-sm text-gray-700">
          {ap.status === "active" ? "Active: drafting before each posting slot." : `Paused${ap.paused_reason ? `: ${ap.paused_reason}` : "."}`}
        </p>
      </Card>
      <Card title="Niche profile">
        <ProfileFields v={v} set={set} />
      </Card>
      <Card title="Accounts, frequency and limits">
        <ScheduleFields v={v} set={set} />
      </Card>
      <Card title="Approval">
        <ApprovalFields />
      </Card>
      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-green-700">Saved</span>}
        <Button loading={busy === "save"} onClick={save}>
          Save settings
        </Button>
      </div>
      <Card title="Delete autopilot" description="Removes its sources, templates, drafts and history. Posts already in your Queue stay there.">
        <ConfirmButton label="Delete autopilot" confirmLabel="Yes, delete it" onConfirm={remove} />
      </Card>
    </div>
  );
}
