import { describe, expect, it, vi } from "vitest"
import { resolveOptions } from "../options.js"
import {
  DEFAULT_GEMINI_ENDPOINT,
  DEFAULT_OPENAI_ENDPOINT,
  baseUrlToEndpoint,
  resolveProvider,
  transportOptions,
} from "../providers.js"
import type { ProviderSpec } from "../providers.js"

const env = (): NodeJS.ProcessEnv => ({})
const noLog = (): void => {}

describe("resolveProvider — built-in gemini (default)", () => {
  const options = resolveOptions({}, env())
  const spec = resolveProvider(options, env(), { log: noLog })

  it("usa el endpoint y la key de Google AI Studio", () => {
    expect(spec.type).toBe("gemini")
    expect(spec.endpoint).toBe(DEFAULT_GEMINI_ENDPOINT)
    expect(spec.apiKeyEnv).toBe("GOOGLE_AI_STUDIO_API_KEY")
    expect(spec.apiKeyFile).toContain("vision-relay.key")
    expect(spec.model).toBe("gemini-3.6-flash")
  })

  it("respeta VISION_MODEL y los overrides top-level", () => {
    const options = resolveOptions({ model: "gemini-3.6-flash-large", endpoint: "https://custom.example/v1/chat/completions" }, env())
    const spec = resolveProvider(options, { VISION_MODEL: "ignored-when-override" }, { log: noLog })
    expect(spec.model).toBe("gemini-3.6-flash-large")
    expect(spec.endpoint).toBe("https://custom.example/v1/chat/completions")
  })

  it("respeta VISION_MODEL del entorno cuando no hay override", () => {
    const options = resolveOptions({}, env())
    const spec = resolveProvider(options, { VISION_MODEL: "gemini-x" }, { log: noLog })
    expect(spec.model).toBe("gemini-x")
  })
})

describe("resolveProvider — openai genérico", () => {
  it("usa el endpoint de OpenAI y OPENAI_API_KEY por defecto", () => {
    const options = resolveOptions({ provider: "openai" }, env())
    const spec = resolveProvider(options, env(), { log: noLog })
    expect(spec.type).toBe("openai")
    expect(spec.endpoint).toBe(DEFAULT_OPENAI_ENDPOINT)
    expect(spec.apiKeyEnv).toBe("OPENAI_API_KEY")
    expect(spec.model).toBe("gpt-4o")
  })

  it("respeta OPENAI_MODEL y percibe overrides de model/endpoint", () => {
    const options = resolveOptions({ provider: "openai", model: "gpt-4o" }, env())
    const spec = resolveProvider(options, { OPENAI_MODEL: "gpt-4.1" }, { log: noLog })
    expect(spec.model).toBe("gpt-4o")
    const noOverride = resolveProvider(resolveOptions({ provider: "openai" }, env()), { OPENAI_MODEL: "gpt-4.1" }, { log: noLog })
    expect(noOverride.model).toBe("gpt-4.1")
  })
})

describe("resolveProvider — proveedores personalizados", () => {
  it("convierte baseUrl en endpoint /chat/completions", () => {
    const options = resolveOptions(
      { provider: "ollama", providers: { ollama: { type: "openai", baseUrl: "http://localhost:11434/v1", model: "llava" } } },
      env(),
    )
    const spec = resolveProvider(options, env(), { log: noLog })
    expect(spec.endpoint).toBe("http://localhost:11434/v1/chat/completions")
    expect(spec.model).toBe("llava")
    expect(spec.apiKeyEnv).toBe("OPENAI_API_KEY")
  })

  it("permite key propia (apiKeyEnv/apiKeyFile) y visionPrompt", () => {
    const options = resolveOptions(
      {
        provider: "groq",
        providers: {
          groq: {
            type: "openai",
            baseUrl: "https://api.groq.com/openai",
            model: "llama-3.2-90b-vision-preview",
            apiKeyEnv: "GROQ_API_KEY",
            visionPrompt: "Describe the terminal screenshot.",
          },
        },
      },
      env(),
    )
    const spec = resolveProvider(options, env(), { log: noLog })
    expect(spec.endpoint).toBe("https://api.groq.com/openai/chat/completions")
    expect(spec.apiKeyEnv).toBe("GROQ_API_KEY")
    expect(spec.visionPrompt).toBe("Describe the terminal screenshot.")
  })

  it("permite sobrescribir un built-in mediante providers.<name>", () => {
    const options = resolveOptions(
      { provider: "gemini", providers: { gemini: { model: "gemini-3.6-pro" } } },
      env(),
    )
    const spec = resolveProvider(options, env(), { log: noLog })
    expect(spec.type).toBe("gemini")
    expect(spec.model).toBe("gemini-3.6-pro")
    expect(spec.endpoint).toBe(DEFAULT_GEMINI_ENDPOINT)
  })

  it("cae a gemini con warning para nombres no configurados", () => {
    const log = vi.fn()
    const options = resolveOptions({ provider: "nope" }, env())
    const spec = resolveProvider(options, env(), { log })
    expect(spec.type).toBe("gemini")
    expect(log).toHaveBeenCalledWith("error", expect.stringContaining("nope"))
  })
})

describe("helpers", () => {
  it("baseUrlToEndpoint normaliza URLs", () => {
    expect(baseUrlToEndpoint("https://api.groq.com/openai/")).toBe("https://api.groq.com/openai/chat/completions")
    expect(baseUrlToEndpoint("http://localhost:11434/v1")).toBe("http://localhost:11434/v1/chat/completions")
    expect(baseUrlToEndpoint("https://x.test/chat/completions")).toBe("https://x.test/chat/completions")
  })

  it("transportOptions ensambla todo el cliente (spec + global + apiKey)", () => {
    const spec: ProviderSpec = resolveProvider(resolveOptions({ provider: "openai", model: "gpt-4o" }, env()), env())
    const transport = transportOptions(spec, "sk-123", resolveOptions({ timeoutMs: 1234, maxRetries: 1, retryDelayMs: 7 }, env()))
    expect(transport).toEqual({
      model: "gpt-4o",
      endpoint: DEFAULT_OPENAI_ENDPOINT,
      apiKey: "sk-123",
      timeoutMs: 1234,
      maxTokens: 2048,
      visionPrompt: expect.stringContaining("You are the vision"),
      maxRetries: 1,
      retryDelayMs: 7,
    })
  })
})