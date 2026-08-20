/**
 * Image downscaling before sending to the vision provider.
 *
 * Screenshots attached to OpenCode are usually full-resolution PNGs — dense
 * images that make the vision model slower and costlier. This module
 * downscales PNG and JPEG data URIs (pure JS, no native deps) to a max width
 * (default 2000 px) before the analysis, which dramatically cuts latency and
 * cost with a negligible quality loss for reading text/UI. Other formats
 * (webp, gif…) and images already smaller than the limit pass through
 * untouched; any decode failure falls back to the original data.
 */

import { PNG } from "pngjs"
import * as jpeg from "jpeg-js"

export const DEFAULT_MAX_RESIZE_WIDTH = 2000

interface RgbaImage {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

/** Area-average downscale (best quality/speed for screenshots). */
function areaResample(src: RgbaImage, maxWidth: number): RgbaImage {
  const width = Math.max(1, Math.min(src.width, maxWidth))
  const height = Math.max(1, Math.round((src.height * width) / src.width))
  if (width >= src.width) return src

  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor((y * src.height) / height)
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * src.height) / height))
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor((x * src.width) / width)
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * src.width) / width))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * src.width
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (row + sx) * 4
          r += src.data[i]!
          g += src.data[i + 1]!
          b += src.data[i + 2]!
          a += src.data[i + 3]!
        }
      }
      const o = (y * width + x) * 4
      const n = (sy1 - sy0) * (sx1 - sx0)
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = a / n
    }
  }
  return { width, height, data: out }
}

interface ParsedDataUri {
  readonly mime: string
  readonly payload: Buffer
}

function parseDataUri(dataUri: string): ParsedDataUri | undefined {
  if (!dataUri.startsWith("data:") || dataUri.length < 20) return undefined
  const comma = dataUri.indexOf(",")
  if (comma === -1) return undefined
  const meta = dataUri.slice(5, comma)
  const mime = meta.split(";")[0]?.toLowerCase() ?? ""
  if (mime === "") return undefined
  try {
    return { mime, payload: Buffer.from(dataUri.slice(comma + 1), "base64") }
  } catch {
    return undefined
  }
}

function toDataUri(mime: string, bytes: Buffer | Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

/**
 * Downscales the image (PNG/JPEG) in a data URI to `maxWidth` px keeping the
 * aspect ratio. Returns the original data URI when the image is already small
 * enough, when `maxWidth` is disabled (0), or when the format is not supported
 * / decoding fails. Never throws.
 */
export async function maybeResizeImage(dataUri: string, maxWidth: number): Promise<string> {
  if (!(maxWidth > 0) || maxWidth < 16) return dataUri
  const parsed = parseDataUri(dataUri)
  if (parsed === undefined) return dataUri

  if (parsed.mime === "image/png") {
    try {
      const png = PNG.sync.read(parsed.payload, { skipRescale: true })
      if (png.width <= maxWidth) return dataUri
      const resized = areaResample({ width: png.width, height: png.height, data: png.data }, maxWidth)
      const out = new PNG({ width: resized.width, height: resized.height })
      out.data.set(resized.data)
      return toDataUri("image/png", PNG.sync.write(out))
    } catch {
      return dataUri
    }
  }

  if (parsed.mime === "image/jpeg") {
    try {
      const decoded = jpeg.decode(parsed.payload, { useTArray: true, maxMemoryUsageInMB: 1024 })
      if (decoded.width <= maxWidth) return dataUri
      const resized = areaResample({ width: decoded.width, height: decoded.height, data: decoded.data }, maxWidth)
      const encoded = jpeg.encode({ width: resized.width, height: resized.height, data: resized.data }, 0.85)
      return toDataUri("image/jpeg", encoded.data)
    } catch {
      return dataUri
    }
  }

  return dataUri
}