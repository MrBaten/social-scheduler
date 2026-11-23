"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApTemplate } from "@/lib/autopilot/types";
import { api } from "../api";
import { Button, Spinner } from "../Button";
import { Alert, Card } from "../Card";
import { ConfirmButton } from "../ConfirmButton";
import { TemplateFields, defaultTemplate, templatePayload, type TemplateDraft } from "./TemplateFields";
import { errorText, newKey } from "./shared";

const PLATFORM_NAME: Record<string, string> = { all: "All platforms", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };

function toDraft(t: ApTemplate): TemplateDraft {
  return {
    key: t.id,
    id: t.id,
    name: t.name,
    platform: t.platform,
    structure: t.structure,
    tone_notes: t.tone_notes,
    hashtag_rules: t.hashtag_rules,
    enabled: t.enabled,
  };
}

export function TemplatesView({ id }: { id: string }) {
  const [templates, setTemplates] = useState<ApTemplate[] | null>(null);
  const [selected, setSelected] = useState<TemplateDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ templates: ApTemplate[] }>(`/api/autopilot/${id}/templates`);
      setTemplates(r.templates ?? []);
      return r.templates ?? [];
    } catch (e) {
      setError(errorText(e));
      return [];
    }
  }, [id]);

  useEffect(() => {
    void load().then((list) => {
      if (list.length) setSelected((cur) => cur ?? toDraft(list[0]));
    });
  }, [load]);

  async function save() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      if (selected.id) {
        const r = await api<{ template: ApTemplate }>(`/api/autopilot/${id}/templates/${selected.id}`, { method: "PATCH", json: templatePayload(selected) });
        setSelected(toDraft(r.template));
      } else {
        const r = await api<{ template: ApTemplate }>(`/api/autopilot/${id}/templates`, { method: "POST", json: templatePayload(selected) });
        setSelected(toDraft(r.template));
      }
      setDirty(false);
      setSaved(true);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected?.id) return;
    try {
      await api(`/api/autopilot/${id}/templates/${selected.id}`, { method: "DELETE" });
      const list = await load();
      setSelected(list.length ? toDraft(list[0]) : null);
      setDirty(false);
    } catch (e) {
      setError(errorText(e));
    }
  }

  function pick(t: TemplateDraft) {
    setSelected(t);
    setDirty(false);
    setSaved(false);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <Card title="Templates" padded={false}>
        {templates === null ? (
          <p className="flex items-center gap-2 px-5 py-4 text-sm text-gray-500">
            <Spinner /> Loading…
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => pick(toDraft(t))}
                  aria-current={selected?.id === t.id ? "true" : undefined}
                  className={`block w-full px-5 py-3 text-left text-sm hover:bg-gray-50 ${selected?.id === t.id ? "bg-violet-50" : ""}`}
                >
                  <span className="font-medium text-gray-900">{t.name}</span>
                  <span className="block text-xs text-gray-500">
                    {PLATFORM_NAME[t.platform] ?? t.platform}
                    {!t.enabled && " · off"}
                  </span>
                </button>
              </li>
            ))}
            {templates.length === 0 && <li className="px-5 py-3 text-sm text-gray-500">No templates: drafts use a built-in default.</li>}
          </ul>
        )}
        <div className="border-t border-gray-100 px-5 py-3">
          <Button variant="secondary" size="sm" onClick={() => pick({ ...defaultTemplate(newKey(), "en"), name: "New template" })}>
            + New template
          </Button>
        </div>
      </Card>

      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        {selected ? (
          <>
            <Card
              title={selected.id ? "Edit template" : "New template"}
              actions={
                <div className="flex items-center gap-2">
                  {saved && !dirty && <span className="text-xs text-green-700">Saved</span>}
                  {selected.id && <ConfirmButton label="Delete" confirmLabel="Delete template" onConfirm={remove} />}
                  <Button size="sm" loading={busy} onClick={save} disabled={!dirty && !!selected.id}>
                    {selected.id ? "Save" : "Create"}
                  </Button>
                </div>
              }
            >
              <TemplateFields
                value={selected}
                onChange={(t) => {
                  setSelected(t);
                  setDirty(true);
                  setSaved(false);
                }}
              />
              <p className="mt-4 text-xs text-gray-400">Image card design comes in Phase 2.</p>
            </Card>
            <TemplatePreview autopilotId={id} structure={selected.structure} />
          </>
        ) : (
          <Card>
            <p className="text-sm text-gray-500">Pick a template or create one.</p>
          </Card>
        )}
      </div>
    </div>
  );
}

function TemplatePreview({ autopilotId, structure }: { autopilotId: string; structure: string }) {
  const [text, setText] = useState<string | null>(null);
  const [sample, setSample] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!structure.trim()) {
      setText("");
      return;
    }
    const my = ++seq.current;
    const t = setTimeout(() => {
      api<{ text: string; sample: boolean }>(`/api/autopilot/${autopilotId}/templates/preview`, { method: "POST", json: { structure } })
        .then((r) => {
          if (my !== seq.current) return;
          setText(r.text);
          setSample(r.sample);
          setError(null);
        })
        .catch((e: unknown) => my === seq.current && setError(errorText(e)));
    }, 400);
    return () => clearTimeout(t);
  }, [autopilotId, structure]);

  return (
    <Card
      title="Live preview"
      description={sample ? "On a sample story (no stories fetched yet)." : "On the newest relevant story. Variables filled directly; with AI on, the model rewrites the content in this shape."}
    >
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : text === null ? (
        <p className="flex items-center gap-2 text-sm text-gray-500">
          <Spinner /> Rendering…
        </p>
      ) : (
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-4 font-sans text-sm text-gray-800">{text}</pre>
      )}
    </Card>
  );
}
