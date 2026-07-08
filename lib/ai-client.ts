import { getAiConfig, type AiConfig } from "@/lib/ai-config";
import type { AiPromptMessage } from "@/lib/ai-prompts";

export interface AiJsonCompletionResult<T> {
  ok: boolean;
  value: T | null;
  model: string | null;
  fallbackUsed: boolean;
  error: string | null;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: unknown;
}

const DEFAULT_AI_TIMEOUT_MS = 12_000;
const DEFAULT_AI_TOTAL_TIMEOUT_MS = 18_000;
const DEFAULT_AI_MAX_TOKENS = 1400;
const OPENROUTER_JSON_RESPONSE_FORMAT_MODELS = new Set([
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "openai/gpt-oss-20b:free",
  "qwen/qwen3-next-80b-a3b-instruct:free"
]);

function completionUrl(config: AiConfig) {
  return `${config.apiUrl}/chat/completions`;
}

function openRouterHeaders(config: AiConfig): Record<string, string> {
  if (config.provider !== "openrouter") return {};

  const siteUrl = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL;
  return {
    ...(siteUrl ? { "HTTP-Referer": siteUrl } : {}),
    "X-Title": "MiniProgram Radar"
  };
}

function responseFormatForModel(config: AiConfig, model: string) {
  if (config.provider === "openrouter" && OPENROUTER_JSON_RESPONSE_FORMAT_MODELS.has(model)) {
    return { response_format: { type: "json_object" } };
  }

  return {};
}

async function fetchTextWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeout);
  }
}

function stringifyProviderError(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const error = value as Record<string, unknown>;
    const parts = [
      typeof error.message === "string" ? error.message : null,
      typeof error.code === "string" || typeof error.code === "number" ? `code=${String(error.code)}` : null
    ];
    const metadata = error.metadata;
    if (typeof metadata === "object" && metadata !== null) {
      const fields = metadata as Record<string, unknown>;
      parts.push(typeof fields.reason === "string" ? fields.reason : null);
      parts.push(typeof fields.raw === "string" ? fields.raw : null);
      parts.push(typeof fields.provider_name === "string" ? `provider=${fields.provider_name}` : null);
    }

    const message = parts.filter(Boolean).join("; ");
    if (message) return message;
  }
  return null;
}

function extractJsonText(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);
  return trimmed;
}

function parseJsonObject<T>(text: string): T {
  const parsed = JSON.parse(extractJsonText(text)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AI response JSON must be an object.");
  }
  return parsed as T;
}

function parseCompletionPayload(text: string) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as ChatCompletionResponse;
  } catch {
    return null;
  }
}

async function requestChatCompletion<T>({
  config,
  model,
  messages,
  timeoutMs
}: {
  config: AiConfig;
  model: string;
  messages: AiPromptMessage[];
  timeoutMs: number;
}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const { response, text } = await fetchTextWithTimeout(
    completionUrl(config),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...openRouterHeaders(config)
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: DEFAULT_AI_MAX_TOKENS,
        stream: false,
        ...responseFormatForModel(config, model)
      })
    },
    timeoutMs
  );

  const payload = parseCompletionPayload(text);
  if (!response.ok) {
    const providerError = stringifyProviderError(payload?.error);
    throw new Error(providerError ? `AI provider rejected ${model}: ${providerError}` : `AI provider rejected ${model} with HTTP ${response.status}.`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(`AI provider returned an empty response for ${model}.`);
  }

  return parseJsonObject<T>(content);
}

export async function createAiJsonCompletion<T>({
  messages,
  timeoutMs = DEFAULT_AI_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_AI_TOTAL_TIMEOUT_MS
}: {
  messages: AiPromptMessage[];
  timeoutMs?: number;
  totalTimeoutMs?: number;
}): Promise<AiJsonCompletionResult<T>> {
  const config = getAiConfig();
  if (!config.configured) {
    return {
      ok: false,
      value: null,
      model: null,
      fallbackUsed: false,
      error: "AI is not configured."
    };
  }

  const models = Array.from(new Set([config.model, config.fallbackModel].filter(Boolean)));
  const errors: string[] = [];
  const startedAt = Date.now();

  for (const model of models) {
    const remainingTimeoutMs = Math.max(0, totalTimeoutMs - (Date.now() - startedAt));
    if (remainingTimeoutMs <= 0) {
      errors.push("AI total timeout budget was exhausted.");
      break;
    }

    try {
      const value = await requestChatCompletion<T>({
        config,
        model,
        messages,
        timeoutMs: Math.min(timeoutMs, remainingTimeoutMs)
      });
      return {
        ok: true,
        value,
        model,
        fallbackUsed: model !== config.model,
        error: null
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    ok: false,
    value: null,
    model: null,
    fallbackUsed: models.length > 1,
    error: errors.join(" | ") || "AI provider did not return a usable JSON response."
  };
}
