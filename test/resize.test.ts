import { describe, expect, it, vi } from "vitest"
import { PNG } from "pngjs"
import * as jpeg from "jpeg-js"
import type { ContentPart } from "@opencode-ai/ai"
import { maybeResizeImage } from "../resize.js"
import { resolveOptions } from "../options.js"
import { relayImages } from "../relay.js"

const toDataUri = (mime: string, bytes: Buffer): string => `data:${mime};base64,${bytes.toString("base64")}`

/** Builds an RGBA PNG of the given size with a deterministic gradient. */
function makePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      png.data[i] = (x * 255) / width
      png.data[i + 1] = (y * 255) / height
      png.data[i + 2] = 128
      png.data[i + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

function makeJpeg(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 80
    data[i + 1] = 160
    data[i + 2] = 240
    data[i + 3] = 255
  }
  return jpeg.encode({ width, height, data }, 0.9).data
}

const decodeUri = async (dataUri: string): Promise<{ width: number; height: number }> => {
  const payload = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64")
  if (dataUri.startsWith("data:image/png")) {
    const png = PNG.sync.read(payload)
    return { width: png.width, height: png.height }
  }
  if (dataUri.startsWith("data:image/jpeg")) {
    const decoded = jpeg.decode(payload)
    return { width: decoded.width, height: decoded.height }
  }
  throw new Error(`unsupported mime: ${dataUri.slice(0, 20)}`)
}

describe("maybeResizeImage — unit", () => {
  it("no toca imágenes ya más pequeñas que maxWidth", async () => {
    const uri = toDataUri("image/png", makePng(800, 600))
    const result = await maybeResizeImage(uri, 2000)
    expect(result).toBe(uri)
  })

  it("no toca la imagen cuando maxWidth es 0 (desactivado)", async () => {
    const uri = toDataUri("image/png", makePng(800, 600))
    expect(await maybeResizeImage(uri, 0)).toBe(uri)
  })

  it("reduce un PNG grande manteniendo aspect ratio y mime", async () => {
    const uri = toDataUri("image/png", makePng(1000, 500))
    const result = await maybeResizeImage(uri, 200)
    expect(result.startsWith("data:image/png;base64,")).toBe(true)
    const dims = await decodeUri(result)
    expect(dims.width).toBe(200)
    expect(dims.height).toBe(100)
  })

  it("reduce un JPEG y conserva el formato", async () => {
    const uri = toDataUri("image/jpeg", makeJpeg(400, 300))
    const result = await maybeResizeImage(uri, 100)
    expect(result.startsWith("data:image/jpeg;base64,")).toBe(true)
    const dims = await decodeUri(result)
    expect(dims.width).toBe(100)
    expect(dims.height).toBe(75)
  })

  it("deja pasar formatos sin decodificador (webp)", async () => {
    const uri = "data:image/webp;base64,UklGRlZJVk9QVEggU0hPV1kgQjE="
    expect(await maybeResizeImage(uri, 100)).toBe(uri)
  })

  it("devuelve la original si el payload no es decodificable", async () => {
    const uri = "data:image/png;base64,bm90IGEgcG5nIGJ1dCB0ZXh0"
    expect(await maybeResizeImage(uri, 100)).toBe(uri)
  })
})

describe("resize en el pipeline de relay", () => {
  it("relayImages envía la versión reducida al proveedor", async () => {
    const uri = toDataUri("image/png", makePng(800, 600))
    const messages: { content: ContentPart[] }[] = [
      { content: [{ type: "text", text: "Mira:" }, { type: "media", mediaType: "image/png", data: uri.slice(uri.indexOf(",") + 1) }] },
    ]
    const options = resolveOptions({ maxResizeWidth: 160, maxImageBytes: 20 * 1024 * 1024 }, {})
    let receivedDim: { width: number; height: number } | undefined
    const analyze = vi.fn(async (dataUri: string) => {
      receivedDim = await decodeUri(dataUri)
      return "ok"
    })

    const stats = await relayImages(messages, { options, analyze, log: () => {} })

    expect(stats).toMatchObject({ total: 1, analyzed: 1 })
    expect(receivedDim).toEqual({ width: 160, height: 120 })
    expect(messages[0]!.content[1]).toMatchObject({ type: "text" })
  })

  it("no redimensiona si maxResizeWidth no se configura (default 2000 no afecta imágenes medianas)", async () => {
    const uri = toDataUri("image/png", makePng(100, 50))
    const messages: { content: ContentPart[] }[] = [
      { content: [{ type: "media", mediaType: "image/png", data: uri.slice(uri.indexOf(",") + 1) }] },
    ]
    const options = resolveOptions({}, {})
    const analyze = vi.fn(async (dataUri: string) => {
      const dims = await decodeUri(dataUri)
      return `ok ${dims.width}x${dims.height}`
    })

    await relayImages(messages, { options, analyze, log: () => {} })

    expect(analyze).toHaveBeenCalledTimes(1)
    const sent = analyze.mock.calls[0]![0] as string
    expect(await decodeUri(sent)).toEqual({ width: 100, height: 50 })
  })
})