import type { ContentPart, MediaPart } from "@opencode-ai/ai"

export interface CollectedImage {
  /** Index of the message inside the messages array. */
  readonly messageIndex: number
  /** Index of the media part inside that message's content array. */
  readonly partIndex: number
  /** Reference to the original media part (used to locate the replacement slot). */
  readonly part: MediaPart
  /** Normalized `data:<mime>;base64,<payload>` data URI ready for the vision provider. */
  readonly dataUri: string
  /** Approximate decoded size in bytes. */
  readonly byteSize: number
}

export const isImageMime = (mime: string): boolean => mime.toLowerCase().startsWith("image/")

export function isImageMedia(part: ContentPart): part is MediaPart {
  return part.type === "media" && isImageMime(part.mediaType)
}

export function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

export function byteSizeOf(data: string | Uint8Array): number {
  if (typeof data === "string") {
    const comma = data.indexOf(",")
    const payload = data.startsWith("data:") && comma !== -1 ? data.slice(comma + 1) : data
    return Math.ceil((payload.length * 3) / 4)
  }
  return data.byteLength
}

export function toDataUri(part: MediaPart): string {
  if (typeof part.data === "string") {
    if (part.data.startsWith("data:")) return part.data
    return `data:${part.mediaType};base64,${part.data}`
  }
  return `data:${part.mediaType};base64,${uint8ToBase64(part.data)}`
}

/**
 * Scans all messages and collects every image media part in order of appearance.
 * Only `media` parts whose mime starts with `image/` are collected; tool-result
 * file content and non-image modalities are left untouched.
 */
export function collectImageParts(messages: readonly { content: readonly ContentPart[] }[]): CollectedImage[] {
  const collected: CollectedImage[] = []
  messages.forEach((message, messageIndex) => {
    message.content.forEach((part, partIndex) => {
      if (isImageMedia(part)) {
        collected.push({
          messageIndex,
          partIndex,
          part,
          dataUri: toDataUri(part),
          byteSize: byteSizeOf(part.data),
        })
      }
    })
  })
  return collected
}
