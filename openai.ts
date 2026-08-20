/**
 * Minimal OpenAI-compatible chat completions client used as the transport for
 * every vision provider (Gemini's OpenAI-compatible endpoint, OpenAI, Groq,
 * OpenRouter, Ollama, LM Studio…). Supports non-streaming `analyzeImage` and
 * SSE streaming `streamImage`, with exponential-backoff retries for transient
 * 429/5xx responses.
 */

export interface OpenAIClientOptions {
  readonly model: string
  readonly endpoint: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly maxTokens: number
  readonly visionPrompt: string
  /** Retries (exponential backoff) for transient 429/5xx responses. Default: 3. */
  readonly maxRetries?: number
  /** Base backoff delay in ms; doubles per retry. Default: 1200. */
  readonly retryDelayMs?: number
}

export const DEFAULT_MAX_RETRIES = 3
export const DEFAULT_RETRY_DELAY_MS = 1200
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

function buildRequestBody(opts: OpenAIClientOptions, dataUri: string, stream: boolean): object {
  return {
    model: opts.model,
    max_tokens: opts.maxTokens,
    ...(stream ? { stream: true } : {}),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: opts.visionPrompt },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ],
  }
}

/**
 * POSTs to the vision provider and returns a usable response. Transient HTTP
 * failures (429/5xx) are retried with exponential backoff; permanent (4xx other
 * than 429) and transport errors (timeouts, network) are returned/thrown right
 * away.
 */
async function requestWithRetry(
  opts: OpenAIClientOptions,
  dataUri: string,
  stream: boolean,
  fetchImpl: FetchLike,
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelay = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  let lastResponse: Response | undefined
  let lastDetail = ""
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchImpl(opts.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(opts, dataUri, stream)),
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
      if (response.ok || !RETRYABLE_STATUSES.has(response.status)) return response
      lastResponse = response
      lastDetail = await response.text().catch(() => "")
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < maxRetries) await sleep(baseDelay * 2 ** attempt)
  }

  if (lastResponse !== undefined) {
    const attempts = maxRetries + 1
    throw new Error(
      `Vision provider HTTP ${lastResponse.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}${
        lastDetail ? ` — ${truncate(lastDetail, 400)}` : ""
      }`,
    )
  }
  if (lastError !== undefined) throw lastError
  throw new Error("Vision provider request failed")
}

/**
 * Sends a single image to the vision provider (OpenAI-compatible chat
 * completions) and returns the model's text description. Throws on transport
 * or response errors so callers can fall back to a notice.
 */
export async function analyzeImage(
  opts: OpenAIClientOptions,
  dataUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const response = await requestWithRetry(opts, dataUri, false, fetchImpl)
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Vision provider HTTP ${response.status}${detail ? ` — ${truncate(detail, 400)}` : ""}`)
  }
  const json = (await response.json()) as ChatCompletionResponse
  const text = contentToText(json.choices?.[0]?.message?.content)
  if (text === "") throw new Error("Vision provider response missing choices[0].message.content")
  return text
}

interface SseChunk {
  choices?: Array<{ delta?: { content?: string } }>
}

/**
 * Streams the vision provider's analysis of a single image (OpenAI-compatible
 * SSE) and yields each text delta as it arrives. Throws on transport or HTTP
 * errors.
 */
export async function* streamImage(
  opts: OpenAIClientOptions,
  dataUri: string,
  fetchImpl: FetchLike = fetch,
): AsyncGenerator<string> {
  const response = await requestWithRetry(opts, dataUri, true, fetchImpl)
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Vision provider HTTP ${response.status}${detail ? ` — ${truncate(detail, 400)}` : ""}`)
  }
  if (response.body === null) throw new Error("Vision provider stream has no body")

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