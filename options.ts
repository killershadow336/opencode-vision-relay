import type { PluginOptions } from "@opencode-ai/plugin"
import { join } from "node:path"
import { homedir } from "node:os"
import { DEFAULT_MAX_RETRIES, DEFAULT_RETRY_DELAY_MS } from "./openai.js"
import type { CustomProviderConfig, ProviderType } from "./providers.js"

export const DEFAULT_MODEL = "gemini-3.6-flash"
export const DEFAULT_API_KEY_FILE = join(homedir(), ".config", "opencode", "vision-relay.key")
export const DEFAULT_DEBUG_LOG_FILE = join(homedir(), ".config", "opencode", "vision-relay.log")

export const DEFAULT_VISION_PROMPT = `You are the vision ("eyes") component of a coding assistant. The main assistant model is text-only: it cannot see images, so it relies entirely on your analysis to reason about the attached image.

Analyze the image with precision and return a detailed, factual description useful for a programming task. Include when relevant:
- visible text / OCR (transcribe it verbatim)
- source code, errors, stack traces, logs, file names
- buttons, menus, dialogs, and other UI elements
- structure and layout, colors, approximate sizes
- tables, graphs, diagrams, charts, and UI states
- any other detail relevant to resolving the user's request

Do NOT try to answer the user's main request. Only describe and analyze the image so the main model can reason about it.

Structure your answer with these sections:
Tipo de imagen: ...
Texto visible: ...
Elementos relevantes: ...
Problema/error observado: ...
Detalles adicionales: ...`

export interface VisionRelayOptions {
  /** Master switch. Default: true. */
  readonly enabled: boolean
  /** Active vision provider: "gemini" (default), "openai", or a name from `providers`. */
  readonly provider: string
  /** Named custom providers (endpoint/model/key). Overrides and extends the built-ins. */
  readonly providers: Readonly<Record<string, CustomProviderConfig>>
  /** Overrides the active provider's model. Default: per provider (gemini-3.6-flash / gpt-4o / VISION_MODEL). */
  readonly model?: string
  /** Overrides the active provider's full OpenAI-compatible chat-completions endpoint. */
  readonly endpoint?: string
  /** Overrides the environment variable that holds the provider API key. */
  readonly apiKeyEnv?: string
  /** Overrides the fallback file that holds the provider API key (read fresh on each dispatch). */
  readonly apiKeyFile?: string
  /** Per-image HTTP timeout in milliseconds. Default: 190_000 (large screenshots take a while; the analysis streams live so the wait is visible). */
  readonly timeoutMs: number
  /** max_tokens for the vision provider response. Default: 2048. */
  readonly maxTokens: number
  /** Maximum number of images analyzed per message. Extra images are skipped with a notice. Default: 10. */
  readonly maxImagesPerMessage: number
  /** Maximum decoded bytes per image. Larger images are skipped with a notice. Default: 15 MiB. */
  readonly maxImageBytes: number
  /** Maximum image width (px) sent to the vision provider; wider PNG/JPEG images are downscaled before analysis (drastic latency/cost drop on big screenshots). Default: 2000. 0 disables. */
  readonly maxResizeWidth: number
  /** Verbose logs (never logs secrets). Default: false. */
  readonly debug: boolean
  /** File where debug/error trace lines are appended when debug is enabled. Default: ~/.config/opencode/vision-relay.log */
  readonly debugLogFile: string
  /** Model ids that are never relayed (they already handle images). */
  readonly skipModels: ReadonlySet<string>
  /** Model ids that are always relayed regardless of catalog capabilities. */
  readonly alwaysProcessModels: ReadonlySet<string>
  /** Behavior when the model is not found in the catalog. Default: true (assume text-only). */
  readonly processUnknownModels: boolean
  /** Instruction sent to the vision provider. Overrides the built-in prompt when set. */
  readonly visionPrompt?: string
  /** Retries (exponential backoff) for transient 429/5xx responses. Default: 3. */
  readonly maxRetries: number
  /** Base backoff delay in ms; doubles per retry. Default: 1200. */
  readonly retryDelayMs: number
  /** Max entries in the per-session analysis cache. Default: 256. */
  readonly cacheMaxEntries: number
}

function num(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function str(value: unknown, fallback: string): string {
  return optStr(value) ?? fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function stringSet(value: unknown): ReadonlySet<string> {
  return Array.isArray(value) ? new Set(value.filter((item): item is string => typeof item === "string")) : new Set()
}

function resolveProviders(value: unknown): Readonly<Record<string, CustomProviderConfig>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const out: Record<string, CustomProviderConfig> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
    const cfg = entry as Record<string, unknown>
    const type: ProviderType | undefined = cfg.type === "gemini" || cfg.type === "openai" ? cfg.type : undefined
    const maxTokens =
      typeof cfg.maxTokens === "number" && Number.isFinite(cfg.maxTokens) && cfg.maxTokens >= 64
        ? cfg.maxTokens
        : undefined
    const item: CustomProviderConfig = {
      ...(type !== undefined ? { type } : {}),
      ...(optStr(cfg.model) !== undefined ? { model: optStr(cfg.model) } : {}),
      ...(optStr(cfg.endpoint) !== undefined ? { endpoint: optStr(cfg.endpoint) } : {}),
      ...(optStr(cfg.baseUrl) !== undefined ? { baseUrl: optStr(cfg.baseUrl) } : {}),
      ...(optStr(cfg.apiKeyEnv) !== undefined ? { apiKeyEnv: optStr(cfg.apiKeyEnv) } : {}),
      ...(optStr(cfg.apiKeyFile) !== undefined ? { apiKeyFile: optStr(cfg.apiKeyFile) } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(optStr(cfg.visionPrompt) !== undefined ? { visionPrompt: optStr(cfg.visionPrompt) } : {}),
    }
    if (Object.keys(item).length > 0) out[name] = item
  }
  return out
}

export function resolveOptions(raw: PluginOptions, env: NodeJS.ProcessEnv): VisionRelayOptions {
  return {
    enabled: bool(raw.enabled, true),
    provider: str(raw.provider, "gemini"),
    providers: resolveProviders(raw.providers),
    model: optStr(raw.model),
    endpoint: optStr(raw.endpoint),
    apiKeyEnv: optStr(raw.apiKeyEnv),
    apiKeyFile: optStr(raw.apiKeyFile),
    timeoutMs: num(raw.timeoutMs, 190_000, 1_000),
    maxTokens: num(raw.maxTokens, 2048, 64),
    maxImagesPerMessage: num(raw.maxImagesPerMessage, 10, 1),
    maxImageBytes: num(raw.maxImageBytes, 15 * 1024 * 1024, 1024),
    maxResizeWidth: num(raw.maxResizeWidth, 2000, 0),
    debug: bool(raw.debug, false),
    debugLogFile: str(raw.debugLogFile, DEFAULT_DEBUG_LOG_FILE),
    skipModels: stringSet(raw.skipModels),
    alwaysProcessModels: stringSet(raw.alwaysProcessModels),
    processUnknownModels: bool(raw.processUnknownModels, true),
    visionPrompt: optStr(raw.visionPrompt),
    maxRetries: num(raw.maxRetries, DEFAULT_MAX_RETRIES, 0),
    retryDelayMs: num(raw.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 0),
    cacheMaxEntries: num(raw.cacheMaxEntries, 256, 1),
  }
}