// Text-model client. One small interface, several providers, chosen by Railway variables:
//   AI_PROVIDER = openai | anthropic | gemini | openrouter | openai_compatible   (default openai)
//   AI_API_KEY  = the provider key (never stored in the DB or sent to the browser)
//   AI_MODEL    = model id. Defaults exist only where checked against provider docs (see below);
//                 for the others you must set it.
//   AI_BASE_URL = only for openai_compatible, e.g. https://api.groq.com/openai/v1
// No key -> aiStatus().configured = false and generation falls back to plain template fill.

export type AiProvider = "openai" | "anthropic" | "gemini" | "openrouter" | "openai_compatible";

const PROVIDERS: AiProvider[] = ["openai", "anthropic", "gemini", "openrouter", "openai_compatible"];

// Defaults verified 2026-11: claude-haiku-5-5 (Anthropic model list); gemini-3.8-flash is the
// example model on ai.google.dev/gemini-api/docs/openai. OpenAI/OpenRouter model names change
// often, so no default: set AI_MODEL.
const DEFAULT_MODEL: Partial<Record<AiProvider, string>> = {
  anthropic: "claude-haiku-5-5",
  gemini: "gemini-3.8-flash",
};

const CHAT_URL: Record<Exclude<AiProvider, "anthropic">, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  openai_compatible: "",
};

export interface AiStatus {
  configured: boolean;
  provider: AiProvider;
  model: string;
  /** Why it isn't usable (shown in the UI), when configured = false. */
  problem: string | null;
}

export function aiStatus(env: NodeJS.ProcessEnv = process.env): AiStatus {
  const raw = (env.AI_PROVIDER || "openai").trim().toLowerCase().replace(/-/g, "_") as AiProvider;
  const provider = PROVIDERS.includes(raw) ? raw : "openai";
  const model = (env.AI_MODEL || DEFAULT_MODEL[provider] || "").trim();
  let problem: string | null = null;
  if (!PROVIDERS.includes(raw)) problem = `Unknown AI_PROVIDER "${env.AI_PROVIDER}"`;
  else if (!env.AI_API_KEY) problem = "AI_API_KEY is not set";
  else if (!model) problem = `Set AI_MODEL for provider ${provider}`;
  else if (provider === "openai_compatible" && !env.AI_BASE_URL) problem = "Set AI_BASE_URL for openai_compatible";
  return { configured: problem === null, provider, model, problem };
}

export interface AiRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export type AiClient = (req: AiRequest) => Promise<string>;

export class AiError extends Error {}

function sanitize(msg: string, key: string | undefined): string {
  let m = msg;
  if (key) m = m.split(key).join("[redacted]");
  return m.replace(/(sk|key)-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 500);
}

/** Real HTTP client for the configured provider. 60 s timeout. */
export function createAiClient(env: NodeJS.ProcessEnv = process.env): AiClient {
  const st = aiStatus(env);
  if (!st.configured) throw new AiError(st.problem ?? "AI not configured");
  const key = env.AI_API_KEY!;

  return async ({ system, user, maxTokens = 2000 }) => {
    let res: Response;
    try {
      if (st.provider === "anthropic") {
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: st.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
          signal: AbortSignal.timeout(60_000),
        });
      } else {
        const url =
          st.provider === "openai_compatible"
            ? `${env.AI_BASE_URL!.replace(/\/$/, "")}/chat/completions`
            : CHAT_URL[st.provider];
        // No temperature / max_tokens: several current OpenAI models reject non-default values and
        // the newer max_completion_tokens name isn't accepted everywhere.
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: st.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
          signal: AbortSignal.timeout(60_000),
        });
      }
    } catch (e) {
      throw new AiError(sanitize(`AI request failed: ${e instanceof Error ? e.message : String(e)}`, key));
    }
    const body = await res.text();
    if (!res.ok) throw new AiError(sanitize(`AI ${st.provider} HTTP ${res.status}: ${body.slice(0, 300)}`, key));
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new AiError("AI returned non-JSON");
    }
    const text =
      st.provider === "anthropic"
        ? ((data as { content?: { type: string; text?: string }[] }).content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("")
        : ((data as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "");
    if (!text.trim()) throw new AiError("AI returned an empty answer");
    return text;
  };
}

/** Pull the first JSON object out of a model answer (handles ```json fences and chatter). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const v = JSON.parse(c.slice(start, end + 1)) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  return null;
}
