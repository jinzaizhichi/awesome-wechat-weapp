export const DEFAULT_OPENAI_API_URL = "https://api.openai.com/v1";
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENAI_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
export const DEFAULT_OPENAI_FALLBACK_MODEL = "qwen/qwen3-next-80b-a3b-instruct:free";

export type AiProvider = "openai" | "openrouter" | "custom";

export interface AiConfig {
  configured: boolean;
  apiKeyConfigured: boolean;
  apiUrl: string;
  model: string;
  fallbackModel: string;
  provider: AiProvider;
}

function normalizeApiUrl(value: string | undefined) {
  const trimmed = value?.trim();
  return (trimmed && trimmed.length > 0 ? trimmed : DEFAULT_OPENAI_API_URL).replace(/\/+$/, "");
}

function providerForApiUrl(apiUrl: string): AiProvider {
  const normalized = apiUrl.toLowerCase();
  if (normalized === OPENROUTER_API_URL) return "openrouter";
  if (normalized === DEFAULT_OPENAI_API_URL) return "openai";
  return "custom";
}

export function getAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const apiUrl = normalizeApiUrl(env.OPENAI_API_URL);
  const apiKeyConfigured = Boolean(env.OPENAI_API_KEY?.trim());
  const model = env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const fallbackModel = env.OPENAI_FALLBACK_MODEL?.trim() || DEFAULT_OPENAI_FALLBACK_MODEL;

  return {
    configured: apiKeyConfigured,
    apiKeyConfigured,
    apiUrl,
    model,
    fallbackModel,
    provider: providerForApiUrl(apiUrl)
  };
}

export function describeAiProvider(provider: AiProvider) {
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "custom") return "Custom OpenAI-compatible endpoint";
  return "OpenAI";
}
