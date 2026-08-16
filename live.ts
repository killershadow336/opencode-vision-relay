import { randomUUID } from "node:crypto"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3TextPart,
} from "@ai-sdk/provider"
import { streamImage, type FetchLike } from "./gemini.js"
import { isImageMime, byteSizeOf, uint8ToBase64 } from "./images.js"
import type { VisionRelayOptions } from "./options.js"
import { buildAnalysisPart } from "./relay.js"

const TOO_LARGE_NOTICE =
  "Esta imagen se omitió porque supera el tamaño máximo configurado (maxImageBytes). Pide al usuario que adjunte una versión más pequeña."
const OVER_LIMIT_NOTICE =
  "Esta imagen se omitió porque se superó el número máximo de imágenes por mensaje (maxImagesPerMessage)."

/** FNV-1a 32-bit hash, same scheme as relay.ts so both paths share cached entries. */
function hash(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

const cacheKeyOf = (deps: LangDeps, dataUri: string): string | undefined => {
  const namespace = deps.sessionID ?? deps.cacheNamespace
  return namespace === undefined ? undefined : `${namespace}:${hash(dataUri)}`
}

function cachedOf(deps: LangDeps, dataUri: string): string | undefined {
  const key = cacheKeyOf(deps, dataUri)
  return key === undefined ? undefined : deps.cache?.get(key)
}

type V3Part = LanguageModelV3TextPart | LanguageModelV3FilePart
type V3Message = LanguageModelV3Prompt[number]

export interface LangDeps {
  readonly options: VisionRelayOptions
  /** Should the relay intervene for this model (text-only, not in skipModels)? */
  readonly shouldProcess: boolean
  readonly resolveApiKey: () => Promise<string | undefined>
  /** Cache of analysis results keyed by `${namespace}:${imageHash}` (optional). */
  readonly cache?: ReadonlyMap<string, string>
  /** Stores a cache entry (the caller owns eviction). */
  readonly cacheSet?: (key: string, value: string) => void
  readonly sessionID?: string
  /** Overrides the cache namespace when there is no session (e.g. aisdk path). */
  readonly cacheNamespace?: string
  /** Injectable fetch (tests / custom transports). Defaults to global fetch. */
  readonly fetchImpl?: FetchLike
  readonly log: (level: "debug" | "error", message: string) => void
}

/** Marks a wrapped model so the language hook never double-wraps the same instance. */
const WRAPPED_MARKER = "opencode.vision-relay.wrapped"

interface CollectedFileImage {
  readonly messageIndex: number
  readonly partIndex: number
  readonly dataUri: string
  readonly byteSize: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fileDataToDataUri(mediaType: string, data: unknown): string | undefined {
  if (typeof data === "string") {
    if (data.startsWith("data:")) return data
    if (data === "") return undefined
    return `data:${mediaType};base64,${data}`
  }
  if (data instanceof Uint8Array) {
    return `data:${mediaType};base64,${uint8ToBase64(data)}`
  }
  return undefined
}

function byteSizeOfData(data: unknown): number {
  if (typeof data === "string") return byteSizeOf(data)
  if (data instanceof Uint8Array) return data.byteLength
  return 0
}

/** Collects image file parts from a v3 prompt, in order of appearance. */
export function collectFileImages(prompt: LanguageModelV3Prompt): CollectedFileImage[] {
  const collected: CollectedFileImage[] = []
  prompt.forEach((message, messageIndex) => {
    const parts = message.content
    if (typeof parts === "string") return
    for (const [partIndex, part] of parts.entries()) {
      if (part.type !== "file" || !isImageMime(part.mediaType)) continue
      const dataUri = fileDataToDataUri(part.mediaType, part.data)
      if (dataUri === undefined) continue
      collected.push({ messageIndex, partIndex, dataUri, byteSize: byteSizeOfData(part.data) })
    }
  })
  return collected
}

/** Replaces every collected image file part with its analysis text block. */
export function sanitizePrompt(
  prompt: LanguageModelV3Prompt,
  images: readonly CollectedFileImage[],
  analyses: readonly string[],
): LanguageModelV3Prompt {
  const next = prompt.map((message) => ({
    ...message,
    content: typeof message.content === "string" ? message.content : [...(message.content as V3Part[])],
  }))
  for (const [i, image] of images.entries()) {
    const message = next[image.messageIndex]
    if (message === undefined) continue
    if (typeof message.content === "string") continue
    if (!(image.partIndex < message.content.length)) continue
    const block = textOf(buildAnalysisPart(i + 1, analyses[i] ?? ""))
    message.content[image.partIndex] = { type: "text", text: block }
  }
  return next as unknown as LanguageModelV3Prompt
}

function textOf(part: { type: string; text?: string }): string {
  return part.type === "text" && part.text !== undefined ? part.text : ""
}

/**
 * Analyzes every image with Gemini (streaming) while yielding the analysis as
 * `reasoning-*` stream parts so the TUI shows it live; accumulates the final
 * text in `analyses` (aligned indexes with `images`).
 */
async function* relayStream(
  images: readonly CollectedFileImage[],
  deps: LangDeps,
  analyses: string[],
): AsyncGenerator<LanguageModelV3StreamPart> {
  const reasoningId = randomUUID()
  yield { type: "reasoning-start", id: reasoningId }

  const apiKey = await deps.resolveApiKey()
  let analyzed = 0

  for (const [i, image] of images.entries()) {
    const index = i + 1

    if (image.byteSize > deps.options.maxImageBytes) {
      analyses[i] = TOO_LARGE_NOTICE
      yield { type: "reasoning-delta", id: reasoningId, delta: textOf(buildAnalysisPart(index, TOO_LARGE_NOTICE)) }
      continue
    }
    if (analyzed >= deps.options.maxImagesPerMessage) {
      analyses[i] = OVER_LIMIT_NOTICE
      yield { type: "reasoning-delta", id: reasoningId, delta: textOf(buildAnalysisPart(index, OVER_LIMIT_NOTICE)) }
      continue
    }
    analyzed++

    if (apiKey === undefined) {
      const body = `ERROR: La variable ${deps.options.apiKeyEnv} (o el archivo vision-relay.key) no está definida, así que esta imagen no se pudo analizar con Gemini.`
      analyses[i] = body
      yield { type: "reasoning-delta", id: reasoningId, delta: textOf(buildAnalysisPart(index, body)) }
      continue
    }

    const cached = cachedOf(deps, image.dataUri)
    if (cached !== undefined) {
      analyses[i] = cached
      deps.log("debug", `image ${index} served from cache (streaming)`)
      yield { type: "reasoning-delta", id: reasoningId, delta: textOf(buildAnalysisPart(index, cached)) }
      continue
    }

    let body = ""
    try {
      const gemini = { ...deps.options, apiKey }
      for await (const delta of streamImage(gemini, image.dataUri, deps.fetchImpl)) {
        body += delta
        yield { type: "reasoning-delta", id: reasoningId, delta }
      }
      if (body.trim() === "") body = "ERROR: Gemini devolvió una respuesta vacía para esta imagen."
    } catch (error) {
      body = `ERROR: No se pudo analizar esta imagen con Gemini (${errorMessage(error).slice(0, 300)}).`
    }
    analyses[i] = body
    const key = cacheKeyOf(deps, image.dataUri)
    if (key !== undefined && deps.cacheSet !== undefined) deps.cacheSet(key, body)
    deps.log("debug", `image ${index} analyzed streaming (${image.byteSize} bytes)`)
  }

  yield { type: "reasoning-end", id: reasoningId }
}

async function* bidi(
  upstream: LanguageModelV3StreamResult,
): AsyncGenerator<LanguageModelV3StreamPart> {
  const reader = upstream.stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Wraps a LanguageModelV3 (AI SDK path — covers aisdk providers like
 * opencode/deepseek). While streaming, every image in the prompt is analyzed
 * by Gemini with the analysis emitted live as reasoning deltas; the actual
 * model request is sent afterwards with the images replaced by the analysis
 * text, so a text-only model never receives raw image bytes.
 */
export function buildWrappedLanguage(original: LanguageModelV3, deps: LangDeps): LanguageModelV3 {
  if ((original as { [WRAPPED_MARKER]?: boolean })[WRAPPED_MARKER] === true) return original

  const analyzeImages = async (
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3Prompt | undefined> => {
    const images = collectFileImages(options.prompt)
    if (images.length === 0) return undefined

    const analyses: string[] = []
    const apiKey = await deps.resolveApiKey()
    let analyzed = 0

    for (const [i, image] of images.entries()) {
      const index = i + 1
      if (image.byteSize > deps.options.maxImageBytes) {
        analyses[i] = TOO_LARGE_NOTICE
        continue
      }
      if (analyzed >= deps.options.maxImagesPerMessage) {
        analyses[i] = OVER_LIMIT_NOTICE
        continue
      }
      analyzed++
      if (apiKey === undefined) {
        analyses[i] = `ERROR: La variable ${deps.options.apiKeyEnv} (o el archivo vision-relay.key) no está definida, así que esta imagen no se pudo analizar con Gemini.`
        continue
      }
      const cached = cachedOf(deps, image.dataUri)
      if (cached !== undefined) {
        analyses[i] = cached
        deps.log("debug", `image ${index} served from cache (generate)`)
        continue
      }
      let body = ""
      try {
        const gemini = { ...deps.options, apiKey }
        for await (const delta of streamImage(gemini, image.dataUri, deps.fetchImpl)) {
          body += delta
        }
        if (body.trim() === "") body = "ERROR: Gemini devolvió una respuesta vacía para esta imagen."
      } catch (error) {
        body = `ERROR: No se pudo analizar esta imagen con Gemini (${errorMessage(error).slice(0, 300)}).`
      }
      analyses[i] = body
      const key = cacheKeyOf(deps, image.dataUri)
      if (key !== undefined && deps.cacheSet !== undefined) deps.cacheSet(key, body)
      deps.log("debug", `image ${index} analyzed (${image.byteSize} bytes)`)
    }

    return sanitizePrompt(options.prompt, images, analyses)
  }

  const wrapped: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: original.provider,
    modelId: original.modelId,
    supportedUrls: original.supportedUrls,
    async doGenerate(options) {
      if (!deps.shouldProcess) return original.doGenerate(options)
      const prompt = await analyzeImages(options)
      if (prompt === undefined) return original.doGenerate(options)
      return original.doGenerate({ ...options, prompt })
    },
    async doStream(options) {
      if (!deps.shouldProcess) return original.doStream(options)
      const images = collectFileImages(options.prompt)
      if (images.length === 0) return original.doStream(options)

      const analyses: string[] = []
      const combined = async function* (): AsyncGenerator<LanguageModelV3StreamPart> {
        yield* relayStream(images, deps, analyses)
        const prompt = sanitizePrompt(options.prompt, images, analyses)
        const upstream = await original.doStream({ ...options, prompt })
        yield* bidi(upstream)
      }

      return { stream: toReadableStream(combined()) }
    },
  }
  ;(wrapped as unknown as { [WRAPPED_MARKER]: boolean })[WRAPPED_MARKER] = true
  return wrapped
}

function toReadableStream<T>(iterator: AsyncGenerator<T>): ReadableStream<T> {
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })
}