import type { PluginOptions } from "@opencode-ai/plugin"
import { join } from "node:path"
import { homedir } from "node:os"

export const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
export const DEFAULT_MODEL = "gemini-3.6-flash"
export const DEFAULT_API_KEY_ENV = "GOOGLE_AI_STUDIO_API_KEY"
export const DEFAULT_API_KEY_FILE = join(homedir(), ".config", "opencode", "vision-relay.key")

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
  /** Gemini model id sent in the request body. Default: VISION_MODEL env or "gemini-3.6-flash". */
  readonly model: string
  /** OpenAI-compatible chat completions endpoint. */
  readonly endpoint: string
  /** Environment variable that holds the Gemini API key. Never hardcoded. */
  readonly apiKeyEnv: string
  /** Fallback file that holds the Gemini API key (read fresh on each dispatch). Used only when the env var is missing or empty. Default: ~/.config/opencode/vision-relay.key */
  readonly apiKeyFile: string
  /** Per-image HTTP timeout in milliseconds. Default: 190_000 (large screenshots take a while; the analysis streams live so the wait is visible). */
  readonly timeoutMs: number
  /** max_tokens for the Gemini response. Default: 2048. */
  readonly maxTokens: number
  /** Maximum number of images analyzed per message. Extra images are skipped with a notice. Default: 10. */
  readonly maxImagesPerMessage: number
  /** Maximum decoded bytes per image. Larger images are skipped with a notice. Default: 15 MiB. */
  readonly maxImageBytes: number
  /** Verbose logs (never logs secrets). Default: false. */
  readonly debug: boolean
  /** Model ids that are never relayed (they already handle images). */
  readonly skipModels: ReadonlySet<string>
  /** Model ids that are always relayed regardless of catalog capabilities. */
  readonly alwaysProcessModels: ReadonlySet<string>
  /** Behavior when the model is not found in the catalog. Default: true (assume text-only). */
  readonly processUnknownModels: boolean
  /** Instruction sent to Gemini. Overrides the built-in prompt when set. */
  readonly visionPrompt: string
  /** Max entries in the per-session analysis cache. Default: 256. */
  readonly cacheMaxEntries: number
}

function num(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function stringSet(value: unknown): ReadonlySet<string> {
  return Array.isArray(value) ? new Set(value.filter((item): item is string => typeof item === "string")) : new Set()
}

export function resolveOptions(raw: PluginOptions, env: NodeJS.ProcessEnv): VisionRelayOptions {
  const apiKeyEnv = str(raw.apiKeyEnv, DEFAULT_API_KEY_ENV)
  const apiKeyFile = str(raw.apiKeyFile, DEFAULT_API_KEY_FILE)
  const model = str(raw.model, env.VISION_MODEL ?? DEFAULT_MODEL)
  return {
    enabled: bool(raw.enabled, true),
    model,
    endpoint: str(raw.endpoint, DEFAULT_ENDPOINT),
    apiKeyEnv,
    apiKeyFile,
    timeoutMs: num(raw.timeoutMs, 190_000, 1_000),
    maxTokens: num(raw.maxTokens, 2048, 64),
    maxImagesPerMessage: num(raw.maxImagesPerMessage, 10, 1),
    maxImageBytes: num(raw.maxImageBytes, 15 * 1024 * 1024, 1024),
    debug: bool(raw.debug, false),
    skipModels: stringSet(raw.skipModels),
    alwaysProcessModels: stringSet(raw.alwaysProcessModels),
    processUnknownModels: bool(raw.processUnknownModels, true),
    visionPrompt: str(raw.visionPrompt, DEFAULT_VISION_PROMPT),
    cacheMaxEntries: num(raw.cacheMaxEntries, 256, 1),
  }
}
