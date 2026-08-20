import { describe, expect, it, vi } from "vitest"
import type {
  LanguageModelV3,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import type { FetchLike } from "../openai.js"
import { buildWrappedLanguage, collectFileImages, sanitizePrompt } from "../live.js"
import { resolveOptions } from "../options.js"
import { resolveProvider, type ProviderSpec } from "../providers.js"

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const options = resolveOptions(
  { apiKeyEnv: "TEST_GEMINI_KEY", timeoutMs: 5_000 },
  { TEST_GEMINI_KEY: "sk-test" },
)

const spec: ProviderSpec = resolveProvider(options, { TEST_GEMINI_KEY: "sk-test" })

const resolveApiKey = async (): Promise<string | undefined> => "sk-test"
const noopLog = (): void => {}

interface Deps {
  options: typeof options
  spec: ProviderSpec
  shouldProcess: boolean
  resolveApiKey: () => Promise<string | undefined>
  log: (level: "debug" | "error", message: string) => void
  fetchImpl?: FetchLike
}

const deps: Deps = { options, spec, shouldProcess: true, resolveApiKey, log: noopLog }

const setFetch = (fetchImpl: FetchLike): void => {
  deps.fetchImpl = fetchImpl
}

const textPart = (text: string) => ({ type: "text" as const, text })
const imageFile = (data: string, mediaType = "image/png") =>
  ({ type: "file" as const, data, mediaType })

const promptWithImage: LanguageModelV3Prompt = [
  { role: "system", content: "Eres un asistente." },
  { role: "user", content: [textPart("Mira esta captura:"), imageFile(PNG_BASE64)] },
  { role: "assistant", content: [textPart("Ok.")] },
]

describe("collectFileImages", () => {
  it("recoge file parts image/* con sus índices y data URI", () => {
    const found = collectFileImages(promptWithImage)
    expect(found).toHaveLength(1)
    expect(found[0]!.messageIndex).toBe(1)
    expect(found[0]!.partIndex).toBe(1)
    expect(found[0]!.dataUri).toMatch(/^data:image\/png;base64,/)
    expect(found[0]!.byteSize).toBeGreaterThan(0)
  })

  it("ignora mensajes system (content string) y file parts no-imagen", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "texto plano" },
      { role: "user", content: [textPart("A"), { type: "file", data: "aGVsbG8=", mediaType: "application/pdf" }] },
    ]
    expect(collectFileImages(prompt)).toHaveLength(0)
  })

  it("ignora file parts con data URL (no descargable en este helper)", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "user", content: [{ type: "file", data: new URL("https://example.com/x.png"), mediaType: "image/png" }] },
    ]
    expect(collectFileImages(prompt)).toHaveLength(0)
  })

  it("soporta data como Uint8Array", () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const prompt: LanguageModelV3Prompt = [
      { role: "user", content: [{ type: "file", data: bytes, mediaType: "image/png" }] },
    ]
    const found = collectFileImages(prompt)
    expect(found).toHaveLength(1)
    expect(found[0]!.dataUri).toBe("data:image/png;base64,iVBORw==")
  })
})

describe("sanitizePrompt", () => {
  it("reemplaza la imagen por el bloque de análisis y conserva el resto", () => {
    const images = collectFileImages(promptWithImage)
    const sanitized = sanitizePrompt(promptWithImage, images, ["Tipo de imagen: captura\nTexto visible: error X"])
    expect(sanitized).toHaveLength(3)
    const user = sanitized[1]!
    expect(user.content).toHaveLength(2)
    const replaced = user.content[1]
    expect(replaced).toMatchObject({ type: "text" })
    const body = (replaced as { text: string }).text
    expect(body).toContain("[IMAGE 1 ANALYSIS]")
    expect(body).toContain("Tipo de imagen: captura")
    expect(body).toContain("[/IMAGE 1 ANALYSIS]")
    expect(sanitized[0]).toEqual(promptWithImage[0])
    expect(sanitized[2]).toEqual(promptWithImage[2])
  })
})

describe("buildWrappedLanguage", () => {
  const sseChunk = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
  const sseDone = "data: [DONE]\n\n"

  const fakeFetch = (() => {
    const impl = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode(sseChunk("Tipo de imagen: captura")))
          controller.enqueue(enc.encode(sseChunk(" de pantalla")))
          controller.enqueue(enc.encode(sseDone))
          controller.close()
        },
      })
      return new Response(body, { status: 200 })
    })
    return impl
  })()

  const makeUpstream = () => {
    const phrases = ["Hola", ", ", "entendido"]
    const upstream: LanguageModelV3 = {
      specificationVersion: "v3",
      provider: "test",
      modelId: "deepseek-test",
      supportedUrls: {},
      doGenerate: vi.fn(async () => ({ text: "gen" }) as never),
      doStream: vi.fn(async () => {
        const chunk = new ReadableStream<LanguageModelV3StreamPart>({
          async pull(controller) {
            for (const delta of phrases) {
              controller.enqueue({ type: "text-delta", id: "t1", delta })
            }
            controller.enqueue({
              type: "finish",
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 3, text: 3, reasoning: 0 },
              },
              finishReason: { unified: "stop", raw: "stop" },
            })
            controller.close()
          },
        })
        return { stream: chunk }
      }),
    }
    return upstream
  }

  it("no llama a Gemini si no hay imágenes en el prompt", async () => {
    setFetch(fakeFetch)
    const upstream = makeUpstream()
    const wrapped = buildWrappedLanguage(upstream, deps)
    const result = await wrapped.doStream({
      prompt: [{ role: "user", content: [textPart("sin imágenes")] }],
    })
    const collected: LanguageModelV3StreamPart[] = []
    const reader = result.stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      collected.push(value)
    }
    expect(collected.some((part) => part.type === "reasoning-start")).toBe(false)
    expect(upstream.doStream).toHaveBeenCalledTimes(1)
  })

  it("emite reasoning-start/deltas/end en vivo y luego el stream del modelo upstream saneado", async () => {
    setFetch(fakeFetch)
    const upstream = makeUpstream()
    const wrapped = buildWrappedLanguage(upstream, deps)

    const result = await wrapped.doStream({ prompt: promptWithImage })
    const parts: LanguageModelV3StreamPart[] = []
    const reader = result.stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }

    const types = parts.map((part) => part.type)
    expect(types[0]).toBe("reasoning-start")
    expect(types.slice(0, -3)).toContain("reasoning-delta")
    expect(types).toContain("reasoning-end")
    expect(types).toContain("text-delta")

    const upstreamOptions = (upstream.doStream as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      prompt: LanguageModelV3Prompt
    }
    const sanitized = upstreamOptions.prompt
    const userContent = sanitized[1]!.content
    expect(userContent[1]).toMatchObject({ type: "text" })
    expect((userContent[1] as { text: string }).text).toContain("Tipo de imagen: captura de pantalla")
  })

  it("no envuelve dos veces la misma instancia", () => {
    const upstream = makeUpstream()
    const once = buildWrappedLanguage(upstream, deps)
    const twice = buildWrappedLanguage(once, deps)
    expect(twice).toBe(once)
  })

  it("usa la API key de deps y llama a Gemini una sola vez por imagen", async () => {
    setFetch(fakeFetch)
    fakeFetch.mockClear()
    const upstream = makeUpstream()
    const wrapped = buildWrappedLanguage(upstream, deps)
    const result = await wrapped.doStream({ prompt: promptWithImage })
    const reader = result.stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })
})