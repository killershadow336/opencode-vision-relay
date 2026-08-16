import { describe, expect, it, vi } from "vitest"
import type { ContentPart } from "@opencode-ai/ai"
import { analyzeImage, type FetchLike } from "../gemini.js"
import { byteSizeOf, toDataUri } from "../images.js"
import { resolveOptions } from "../options.js"
import { buildAnalysisPart, relayImages, replaceMediaWithNotice } from "../relay.js"

type TestMessage = { content: ContentPart[] }

const text = (value: string): ContentPart => ({ type: "text", text: value })
const media = (mediaType: string, data: string): ContentPart => ({ type: "media", mediaType, data })

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const options = resolveOptions({}, {})
const noopLog = (): void => {}

const messageWithImages = (count: number): TestMessage[] => [
  { content: [text("Analiza esto:"), ...Array.from({ length: count }, () => media("image/png", PNG_BASE64))] },
]

describe("A) mensaje sin imagen → Gemini NO es llamado", () => {
  it("no llama a analyze y devuelve stats vacías", async () => {
    const analyze = vi.fn(async () => "should not be called")
    const messages = [{ content: [text("hola"), text("sin imágenes")] }]

    const stats = await relayImages(messages, { options, analyze, log: noopLog })

    expect(stats).toEqual({ total: 0, analyzed: 0, tooLarge: 0, overLimit: 0, failed: 0 })
    expect(analyze).not.toHaveBeenCalled()
    expect(messages[0]!.content).toHaveLength(2)
  })
})

describe("B) mensaje con una imagen → Gemini recibe la imagen y DeepSeek recibe la descripción", () => {
  it("llama a analyze con la data URI, reemplaza la imagen y conserva el texto", async () => {
    const analyze = vi.fn(async (dataUri: string) => {
      expect(dataUri).toMatch(/^data:image\/png;base64,/)
      return "Tipo de imagen: captura de pantalla\nTexto visible: console.log('hola')\n"
    })
    const messages = messageWithImages(1)

    const stats = await relayImages(messages, { options, analyze, log: noopLog })

    expect(analyze).toHaveBeenCalledTimes(1)
    expect(stats).toMatchObject({ total: 1, analyzed: 1, failed: 0 })
    const parts = messages[0]!.content
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual(text("Analiza esto:"))
    expect(parts[1]).toMatchObject({ type: "text" })
    const body = (parts[1] as { text: string }).text
    expect(body).toContain("[IMAGE 1 ANALYSIS]")
    expect(body).toContain("[/IMAGE 1 ANALYSIS]")
    expect(body).toContain("console.log('hola')")
    expect(body).not.toContain(PNG_BASE64)
  })
})

describe("C) mensaje con 2+ imágenes → todas procesadas y separadas", () => {
  it("llama a analyze por cada imagen y genera bloques numerados e independientes", async () => {
    const uris: string[] = []
    const analyze = vi.fn(async (dataUri: string) => {
      uris.push(dataUri)
      return `Análisis de imagen ${uris.length}`
    })
    const distinct = (suffix: string) => `data:image/png;base64,${Buffer.from(suffix).toString("base64")}`
    const messages: TestMessage[] = [
      { content: [text("Analiza esto:"), media("image/png", PNG_BASE64)] },
      { content: [media("image/png", distinct("a"))] },
      { content: [media("image/jpeg", distinct("b"))] },
    ]

    const stats = await relayImages(messages, { options, analyze, log: noopLog })

    expect(analyze).toHaveBeenCalledTimes(3)
    expect(new Set(uris).size).toBe(3)
    expect(stats.analyzed).toBe(3)
    const first = messages[0]!.content
    expect(first).toHaveLength(2)
    expect((first[1] as { text: string }).text).toContain("[IMAGE 1 ANALYSIS]")
    expect((first[1] as { text: string }).text).toContain("Análisis de imagen 1")
    expect((messages[1]!.content[0] as { text: string }).text).toContain("[IMAGE 2 ANALYSIS]")
    expect((messages[1]!.content[0] as { text: string }).text).toContain("Análisis de imagen 2")
    expect((messages[2]!.content[0] as { text: string }).text).toContain("[IMAGE 3 ANALYSIS]")
    expect((messages[2]!.content[0] as { text: string }).text).toContain("Análisis de imagen 3")
  })
})

describe("D) Gemini devuelve error → OpenCode no se rompe", () => {
  it("no lanza y sustituye la imagen por un aviso de error", async () => {
    const analyze = vi.fn(async () => {
      throw new Error("Gemini HTTP 429")
    })
    const messages = messageWithImages(1)

    const stats = await relayImages(messages, { options, analyze, log: noopLog })

    expect(stats).toMatchObject({ total: 1, analyzed: 1, failed: 1 })
    const replacement = messages[0]!.content[1] as { text: string }
    expect(replacement.text).toContain("ERROR")
    expect(replacement.text).toContain("Gemini HTTP 429")
    expect(replacement.text).toContain("[IMAGE 1 ANALYSIS]")
  })

  it("no propaga errores inesperados del analizador", async () => {
    const analyze = vi.fn(async () => {
      throw new TypeError("boom")
    })
    await expect(relayImages(messageWithImages(1), { options, analyze, log: noopLog })).resolves.toMatchObject({
      failed: 1,
    })
  })
})

describe("limites", () => {
  it("omite imágenes que superan maxImageBytes", async () => {
    const analyze = vi.fn(async () => "ok")
    const small = resolveOptions({ maxImageBytes: 1024 }, {})
    const big = PNG_BASE64.repeat(30)
    const messages: TestMessage[] = [{ content: [media("image/png", big)] }]

    const stats = await relayImages(messages, { options: small, analyze, log: noopLog })

    expect(analyze).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ tooLarge: 1, analyzed: 0 })
    const replacement = messages[0]!.content[0] as { text: string }
    expect(replacement.text).toContain("se omitió porque supera el tamaño máximo")
  })

  it("respeta maxImagesPerMessage y avisa de las omitidas", async () => {
    const analyze = vi.fn(async () => "ok")
    const limited = resolveOptions({ maxImagesPerMessage: 2 }, {})
    const messages = messageWithImages(3)

    const stats = await relayImages(messages, { options: limited, analyze, log: noopLog })

    expect(analyze).toHaveBeenCalledTimes(2)
    expect(stats).toMatchObject({ analyzed: 2, overLimit: 1 })
    const parts = messages[0]!.content
    expect((parts[1] as { text: string }).text).toContain("[IMAGE 1 ANALYSIS]")
    expect((parts[2] as { text: string }).text).toContain("[IMAGE 2 ANALYSIS]")
    expect((parts[3] as { text: string }).text).toContain("se superó el número máximo")
  })
})

describe("helpers", () => {
  it("buildAnalysisPart formatea el bloque solicitado", () => {
    const part = buildAnalysisPart(1, "Tipo de imagen: captura") as { text: string }
    expect(part.text).toBe("[IMAGE 1 ANALYSIS]\nTipo de imagen: captura\n[/IMAGE 1 ANALYSIS]")
  })

  it("toDataUri normaliza base64 y mantiene data URIs ya formadas", () => {
    expect(toDataUri({ type: "media", mediaType: "image/png", data: PNG_BASE64 })).toBe(
      `data:image/png;base64,${PNG_BASE64}`,
    )
    const raw = "abc123"
    expect(toDataUri({ type: "media", mediaType: "image/png", data: Buffer.from(raw) })).toBe(
      `data:image/png;base64,${Buffer.from(raw).toString("base64")}`,
    )
  })

  it("byteSizeOf estima el tamaño decodificado", () => {
    expect(byteSizeOf(PNG_BASE64)).toBe(Math.ceil((PNG_BASE64.length * 3) / 4))
    expect(byteSizeOf(new Uint8Array([1, 2, 3]))).toBe(3)
  })

  it("replaceMediaWithNotice sustituye imágenes pero no toca texto", () => {
    const messages: TestMessage[] = [{ content: [text("hola"), media("image/webp", PNG_BASE64)] }]
    const replaced = replaceMediaWithNotice(messages, "aviso")
    expect(replaced).toBe(1)
    expect(messages[0]!.content[1]).toEqual(text("aviso"))
  })
})

describe("gemini.ts — cliente OpenAI-compatible", () => {
  it("parsea respuestas con content en string", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Texto visible: X" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    const result = await analyzeImage(
      { model: "gemini-3.6-flash", endpoint: "https://example.com/chat/completions", apiKey: "sk-test", timeoutMs: 1000, maxTokens: 2048, visionPrompt: "p" },
      "data:image/png;base64,abc",
      fetchImpl,
    )
    expect(result).toBe("Texto visible: X")
    const init = fetchImpl.mock.calls[0]![1]
    expect(init).toBeDefined()
    const body = JSON.parse(init!.body as string)
    expect(body.model).toBe("gemini-3.6-flash")
    expect(body.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,abc" } })
    expect(init!.headers).toMatchObject({ Authorization: "Bearer sk-test" })
  })

  it("parsea respuestas con content en array de partes", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] }), {
        status: 200,
      }),
    )
    await expect(
      analyzeImage(
        { model: "gemini-3.6-flash", endpoint: "https://example.com", apiKey: "k", timeoutMs: 1000, maxTokens: 2048, visionPrompt: "p" },
        "data:image/png;base64,abc",
        fetchImpl,
      ),
    ).resolves.toBe("ab")
  })

  it("lanza ante un HTTP de error", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("rate limit", { status: 429 }))
    await expect(
      analyzeImage(
        { model: "gemini-3.6-flash", endpoint: "https://example.com", apiKey: "k", timeoutMs: 1000, maxTokens: 2048, visionPrompt: "p" },
        "data:image/png;base64,abc",
        fetchImpl,
      ),
    ).rejects.toThrow(/Gemini HTTP 429/)
  })
})
