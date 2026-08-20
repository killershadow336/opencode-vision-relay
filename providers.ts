import { join } from "node:path"
import { homedir } from "node:os"
import type { OpenAIClientOptions } from "./openai.js"
import { DEFAULT_API_KEY_FILE, DEFAULT_MODEL, DEFAULT_VISION_PROMPT } from "./options.js"
import type { VisionRelayOptions } from "./options.js"

/**
 * Vision provider resolution. The plugin is transport-agnostic: every provider
 * speaks the OpenAI chat-completions protocol, so a provider is just a set of
 * (endpoint, model, key-location, prompts) defaults plus optional overrides.
 *
 * - `"gemini"` (default): Google AI Studio's OpenAI-compatible endpoint.
 * - `"openai"`: any OpenAI-compatible API (OpenAI, Groq, OpenRouter, Ollama,
 *   LM Studio, vLLM, etc.), defaulting to api.openai.com.
 * - any other string: a named entry in `options.providers`.
 */

export type ProviderType = "gemini" | "openai"

export const DEFAULT_GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
export const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions"

export const DEFAULT_GEMINI_API_KEY_ENV = "GOOGLE_AI_STUDIO_API_KEY"
export const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY"
export const DEFAULT_OPENAI_API_KEY_FILE = join(homedir(), ".config", "opencode", "openai.key")
/** Sensible generic default for the "openai" family; users normally override with `model`. */
export const DEFAULT_OPENAI_MODEL = "gpt-4o"

/** Fully-resolved settings for the active vision provider (no `undefined` left). */
export interface ProviderSpec {
  readonly type: ProviderType
  readonly model: string
  readonly endpoint: string
  readonly apiKeyEnv: string
  readonly apiKeyFile: string
  readonly maxTokens: number
  readonly visionPrompt: string
}

/** Raw entry accepted under `options.providers.<name>`. All fields optional. */
export interface CustomProviderConfig {
  readonly type?: ProviderType
  readonly model?: string
  readonly endpoint?: string
  readonly baseUrl?: string
  readonly apiKeyEnv?: string
  readonly apiKeyFile?: string
  readonly maxTokens?: number
  readonly visionPrompt?: string
}

/** Human-readable label for logs/notices. */
export function providerLabel(spec: ProviderSpec): string {
  return spec.type === "gemini" ? "Gemini" : "OpenAI-compatible"
}

/** Appends `/chat/completions` to a base URL unless it already ends with it. */
export function baseUrlToEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`
}

export interface ResolveProviderHooks {
  readonly log?: (level: "debug" | "error", message: string) => void
}

function defaultSpecFor(type: ProviderType, options: VisionRelayOptions, env: NodeJS.ProcessEnv): ProviderSpec {
  if (type === "openai") {
    return {
      type,
      model: env.OPENAI_MODEL ?? env.VISION_MODEL ?? DEFAULT_OPENAI_MODEL,
      endpoint: DEFAULT_OPENAI_ENDPOINT,
      apiKeyEnv: DEFAULT_OPENAI_API_KEY_ENV,
      apiKeyFile: DEFAULT_OPENAI_API_KEY_FILE,
      maxTokens: options.maxTokens,
      visionPrompt: options.visionPrompt ?? DEFAULT_VISION_PROMPT,
    }
  }
  return {
    type,
    model: env.VISION_MODEL ?? DEFAULT_MODEL,
    endpoint: DEFAULT_GEMINI_ENDPOINT,
    apiKeyEnv: DEFAULT_GEMINI_API_KEY_ENV,
    apiKeyFile: DEFAULT_API_KEY_FILE,
    maxTokens: options.maxTokens,
    visionPrompt: options.visionPrompt ?? DEFAULT_VISION_PROMPT,
  }
}

/**
 * Resolves the active provider spec from the (already parsed) options.
 *
 * Priority per field: custom provider config → top-level options override →
 * provider-type default. Unknown provider names fall back to `gemini` and warn.
 */
export function resolveProvider(
  options: VisionRelayOptions,
  env: NodeJS.ProcessEnv,
  hooks: ResolveProviderHooks = {},
): ProviderSpec {
  const id = options.provider
  const custom = options.providers[id]

  let type: ProviderType
  if (custom !== undefined) {
    type = custom.type ?? (id === "gemini" ? "gemini" : "openai")
  } else if (id === "gemini") {
    type = "gemini"
  } else if (id === "openai") {
    type = "openai"
  } else {
    type = "gemini"
    hooks.log?.("error", `provider "${id}" is not configured in \`providers\`; falling back to "gemini"`)
  }

  const defaults = defaultSpecFor(type, options, env)
  const cfg = custom ?? {}

  const endpoint = cfg.endpoint ?? (cfg.baseUrl !== undefined ? baseUrlToEndpoint(cfg.baseUrl) : undefined)

  return {
    type: defaults.type,
    model: cfg.model ?? options.model ?? defaults.model,
    endpoint: endpoint ?? options.endpoint ?? defaults.endpoint,
    apiKeyEnv: cfg.apiKeyEnv ?? options.apiKeyEnv ?? defaults.apiKeyEnv,
    apiKeyFile: cfg.apiKeyFile ?? options.apiKeyFile ?? defaults.apiKeyFile,
    maxTokens: cfg.maxTokens ?? options.maxTokens,
    visionPrompt: cfg.visionPrompt ?? options.visionPrompt ?? defaults.visionPrompt,
  }
}

/** Builds the transport options for the OpenAI-compatible client. */
export function transportOptions(
  spec: ProviderSpec,
  apiKey: string,
  options: VisionRelayOptions,
): OpenAIClientOptions {
  return {
    model: spec.model,
    endpoint: spec.endpoint,
    apiKey,
    timeoutMs: options.timeoutMs,
    maxTokens: spec.maxTokens,
    visionPrompt: spec.visionPrompt,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
  }
}