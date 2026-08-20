import type { ContentPart } from "@opencode-ai/ai"
import { collectImageParts, type CollectedImage } from "./images.js"
import type { VisionRelayOptions } from "./options.js"

export interface RelayContext {
  readonly options: VisionRelayOptions
  /** Analyzes a single image (data URI) and resolves with its description. */
  readonly analyze: (dataUri: string) => Promise<string>
  /** Session-scoped cache of analysis results, keyed by `${sessionID}:${imageHash}`. */
  readonly cache?: ReadonlyMap<string, string>
  /** Stores a cache entry (the caller owns eviction). */
  readonly cacheSet?: (key: string, value: string) => void
  readonly sessionID?: string
  readonly log: (level: "debug" | "error", message: string) => void
}

export interface RelayStats {
  total: number
  analyzed: number
  tooLarge: number
  overLimit: number
  failed: number
}

const EMPTY_STATS: RelayStats = { total: 0, analyzed: 0, tooLarge: 0, overLimit: 0, failed: 0 }

const TOO_LARGE_NOTICE =
  "Esta imagen se omitió porque supera el tamaño máximo configurado (maxImageBytes). Pide al usuario que adjunte una versión más pequeña."
const OVER_LIMIT_NOTICE =
  "Esta imagen se omitió porque se superó el número máximo de imágenes por mensaje (maxImagesPerMessage)."

/** FNV-1a 32-bit hash used to fingerprint image data for the analysis cache. */
function hash(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function buildAnalysisPart(index: number, body: string, description?: string): ContentPart {
  const header = description === undefined ? "" : `Descripción del usuario: ${description}\n`
  const text = `[IMAGE ${index} ANALYSIS]\n${header}${body.trim()}\n[/IMAGE ${index} ANALYSIS]`
  return { type: "text", text }
}

export function buildErrorPart(index: number, error: unknown): ContentPart {
  const text = `[IMAGE ${index} ANALYSIS]\nERROR: No se pudo analizar esta imagen con el proveedor de visión (${truncate(errorMessage(error), 300)}). El modelo principal no puede ver esta imagen.\n[/IMAGE ${index} ANALYSIS]`
  return { type: "text", text }
}

/** Replaces every image media part with a plain-text notice. Used when the vision provider is unavailable. */
export function replaceMediaWithNotice(messages: { content: ContentPart[] }[], notice: string): number {
  let replaced = 0
  for (const message of messages) {
    message.content = message.content.map((part) => {
      if (part.type !== "media" || !part.mediaType.toLowerCase().startsWith("image/")) return part
      replaced++
      return { type: "text", text: notice }
    })
  }
  return replaced
}

/**
 * Analyzes every image in the given messages with the active vision provider
 * and replaces each image media part with a structured text analysis block.
 * Never throws: errors become per-image notices so the downstream (possibly
 * text-only) model is never left with a raw image part.
 */
export async function relayImages(messages: { content: ContentPart[] }[], ctx: RelayContext): Promise<RelayStats> {
  const { options, analyze, log } = ctx
  const collected = collectImageParts(messages)
  if (collected.length === 0) return EMPTY_STATS

  const stats: RelayStats = { total: collected.length, analyzed: 0, tooLarge: 0, overLimit: 0, failed: 0 }
  const replacements = new Map<CollectedImage, ContentPart>()

  for (const [position, image] of collected.entries()) {
    const index = position + 1
    const description =
      image.part.metadata && typeof image.part.metadata.description === "string"
        ? image.part.metadata.description
        : undefined

    if (image.byteSize > options.maxImageBytes) {
      stats.tooLarge++
      replacements.set(image, buildAnalysisPart(index, TOO_LARGE_NOTICE, description))
      continue
    }
    if (stats.analyzed >= options.maxImagesPerMessage) {
      stats.overLimit++
      replacements.set(image, buildAnalysisPart(index, OVER_LIMIT_NOTICE, description))
      continue
    }

    stats.analyzed++
    const cacheKey = ctx.sessionID === undefined ? undefined : `${ctx.sessionID}:${hash(image.dataUri)}`
    const cached = cacheKey === undefined ? undefined : ctx.cache?.get(cacheKey)
    if (cached !== undefined) {
      log("debug", `image ${index} served from cache`)
      replacements.set(image, buildAnalysisPart(index, cached, description))
      continue
    }

    try {
      const analysis = await analyze(image.dataUri)
      if (cacheKey !== undefined && ctx.cacheSet !== undefined) ctx.cacheSet(cacheKey, analysis)
      replacements.set(image, buildAnalysisPart(index, analysis, description))
      log("debug", `image ${index} analyzed (${image.byteSize} bytes)`)
    } catch (error) {
      stats.failed++
      log("error", `failed to analyze image ${index}: ${truncate(errorMessage(error), 200)}`)
      replacements.set(image, buildErrorPart(index, error))
    }
  }

  for (const image of collected) {
    const replacement = replacements.get(image)
    const message = messages[image.messageIndex]
    if (replacement === undefined || message === undefined) continue
    if (image.partIndex < message.content.length) {
      message.content[image.partIndex] = replacement
    }
  }

  return stats
}
