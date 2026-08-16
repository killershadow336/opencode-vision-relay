export interface GeminiOptions {
  readonly model: string
  readonly endpoint: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly maxTokens: number
  readonly visionPrompt: string
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Parses a single SSE `data:` JSON payload (already stripped of the prefix). */
export function parseSseJson<T>(payload: string): T | undefined {
  if (payload === "" || payload === "[DONE]") return undefined
  try {
    return JSON.parse(payload) as T
  } catch {
    return undefined
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text
          : "",
      )
      .join("")
      .trim()
  }
  return ""
}

/**
 * Sends a single image to Gemini through its OpenAI-compatible chat completions
 * endpoint and returns the model's text description. Throws on transport or
 * response errors so callers can fall back to a notice.
 */
export async function analyzeImage(opts: GeminiOptions, dataUri: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(opts.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: opts.visionPrompt },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Gemini HTTP ${response.status}${detail ? ` — ${truncate(detail, 400)}` : ""}`)
  }

  const json = (await response.json()) as ChatCompletionResponse
  const text = contentToText(json.choices?.[0]?.message?.content)
  if (text === "") throw new Error("Gemini response missing choices[0].message.content")
  return text
}

interface SseChunk {
  choices?: Array<{ delta?: { content?: string } }>
}

/**
 * Streams Gemini's analysis of a single image (OpenAI-compatible SSE) and
 * yields each text delta as it arrives. Throws on transport or HTTP errors.
 */
export async function* streamImage(
  opts: GeminiOptions,
  dataUri: string,
  fetchImpl: FetchLike = fetch,
): AsyncGenerator<string> {
  const response = await fetchImpl(opts.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: opts.visionPrompt },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Gemini HTTP ${response.status}${detail ? ` — ${truncate(detail, 400)}` : ""}`)
  }
  if (response.body === null) throw new Error("Gemini stream has no body")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const payload = trimmed.slice(5).trim()
        if (payload === "[DONE]") return
        const chunk = parseSseJson<SseChunk>(payload)
        const delta = chunk?.choices?.[0]?.delta?.content
        if (delta !== undefined && delta !== "") yield delta
      }
    }
  } finally {
    reader.releaseLock()
  }
}
