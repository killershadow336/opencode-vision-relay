import { Plugin } from "@opencode-ai/plugin"
import type { ContentPart } from "@opencode-ai/ai"
import type { Model } from "@opencode-ai/schema/model"
import { readFile } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import { analyzeImage } from "./openai.js"
import { isImageMime } from "./images.js"
import { buildWrappedLanguage } from "./live.js"
import { resolveOptions, type VisionRelayOptions } from "./options.js"
import { providerLabel, resolveProvider, transportOptions, type ProviderSpec } from "./providers.js"
import { relayImages, replaceMediaWithNotice } from "./relay.js"

interface RelayState {
  readonly options: VisionRelayOptions
  readonly capabilities: Map<string, ReadonlySet<string>>
  lastFetch: number
  readonly cache: Map<string, string>
}

const CAPABILITIES_TTL_MS = 5 * 60_000

const modelKey = (providerID: string, modelID: string): string => `${providerID}/${modelID}`

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function supportsVision(input: ReadonlySet<string>): boolean {
  return input.has("image") || input.has("media")
}

/**
 * Resolves the active provider's API key at dispatch time. Order: env var
 * (e.g. GOOGLE_AI_STUDIO_API_KEY) → fallback file (e.g.
 * ~/.config/opencode/vision-relay.key). Reading the file fresh on each dispatch
 * makes the plugin resilient to service restarts, regardless of which process
 * spawned the service and what environment it inherited.
 */
async function resolveApiKey(spec: ProviderSpec): Promise<string | undefined> {
  const fromEnv = process.env[spec.apiKeyEnv]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  try {
    const fromFile = (await readFile(spec.apiKeyFile, "utf8")).trim()
    return fromFile === "" ? undefined : fromFile
  } catch {
    return undefined
  }
}

export default Plugin.define({
  id: "opencode.vision-relay",
  setup: async (ctx) => {
    // Absolute trace path: the service process runs with stdout→/dev/null, and
    // plugin options have been observed not always reaching resolveOptions at
    // runtime (bun module cache). A fixed path keeps the trace observable.
    const TRACE_PATH = "/home/killershadow/.config/opencode/vision-relay.trace.log"
    const trace = (level: string, message: string): void => {
      try {
        appendFileSync(TRACE_PATH, `${new Date().toISOString()} [${level}] ${message}\n`)
      } catch {
        /* best-effort */
      }
    }

    const options = resolveOptions(ctx.options, process.env)
    const log = (level: "debug" | "error", message: string): void => {
      if (level === "error") console.warn(`[vision-relay] ${message}`)
      else if (options.debug) console.log(`[vision-relay] ${message}`)
      if (options.debug) trace(level, message)
    }

    // Active provider spec: "gemini" (default), "openai", or a named custom
    // provider from options.providers. Unknown names fall back to gemini.
    const spec = resolveProvider(options, process.env, { log })

    trace("info", `[boot] enabled=${options.enabled} debug=${options.debug}`)
    trace("info", `[boot] provider=${spec.type} model=${spec.model} endpoint=${spec.endpoint}`)
    trace("info", `[boot] raw options: ${JSON.stringify(ctx.options)}`)

    if (!options.enabled) {
      log("debug", "disabled via options.enabled=false")
      return
    }

    const state: RelayState = {
      options,
      capabilities: new Map(),
      lastFetch: 0,
      cache: new Map(),
    }

    const cacheSet = (key: string, value: string): void => {
      state.cache.delete(key)
      if (state.cache.size >= options.cacheMaxEntries) {
        const oldest = state.cache.keys().next().value
        if (oldest !== undefined) state.cache.delete(oldest)
      }
      state.cache.set(key, value)
    }

    const loadCapabilities = async (force: boolean): Promise<void> => {
      if (!force && Date.now() - state.lastFetch < CAPABILITIES_TTL_MS) return
      try {
        const result = await ctx.catalog.model.list()
        for (const model of result.data) {
          state.capabilities.set(modelKey(model.providerID, model.modelID), new Set(model.capabilities.input))
        }
        state.lastFetch = Date.now()
        log("debug", `loaded input capabilities for ${result.data.length} models`)
      } catch (error) {
        log("error", `could not load model catalog: ${errorMessage(error)}`)
      }
    }

    const shouldProcess = async (ref: { readonly providerID: string; readonly id: string }): Promise<boolean> => {
      if (options.alwaysProcessModels.has(ref.id)) return true
      if (options.skipModels.has(ref.id)) return false
      await loadCapabilities(false)
      const capabilities = state.capabilities.get(modelKey(ref.providerID, ref.id))
      if (capabilities === undefined) return options.processUnknownModels
      return !supportsVision(capabilities)
    }

    /** Same rule but from a Model.Info (used by the aisdk.language hook, where capabilities are inline). */
    const shouldProcessInfo = (info: Model.Info): boolean => {
      if (options.alwaysProcessModels.has(info.modelID)) return true
      if (options.skipModels.has(info.modelID)) return false
      const input = info.capabilities?.input
      if (input === undefined || input.length === 0) return options.processUnknownModels
      return !supportsVision(new Set(input))
    }

    // Providers routed through the AI SDK (package like `aisdk:@ai-sdk/...`).
    // Those models are wrapped in the aisdk.language hook for live streaming;
    // the context hook must skip them to avoid analyzing images twice.
    const aisdkProviders = new Set<string>()
    try {
      const providers = await ctx.catalog.provider.list()
      for (const provider of providers.data) {
        if (typeof provider.package === "string" && provider.package.startsWith("aisdk:")) {
          aisdkProviders.add(provider.id)
        }
      }
      log("debug", `aisdk-routed providers: ${[...aisdkProviders].join(", ") || "(none)"}`)
    } catch (error) {
      log("error", `could not load providers: ${errorMessage(error)}`)
    }

    await loadCapabilities(true)

    const registration = await ctx.session.hook("context", async (event) => {
      // A failing hook fails the dispatch, so everything here is defensive.
      try {
        const messages = event.messages as unknown as { content: ContentPart[] }[]

        const hasImages = messages.some((message) =>
          message.content.some((part) => part.type === "media" && isImageMime(part.mediaType)),
        )
        if (!hasImages) return

        if (!(await shouldProcess(event.model))) {
          log("debug", `model ${event.model.providerID}/${event.model.id} already supports images; not relaying`)
          return
        }

        // IMPORTANTE: no se puede delegar el relay al wrapper aisdk.language,
        // aunque el provider sea aisdk-routed. opencode valida las capacidades
        // del modelo ANTES de llegar al pump aisdk: para un modelo text-only
        // descarta los file-parts con "this model does not support image input"
        // y el wrapper jamás llega a ejecutarse. El hook context es la única
        // intercepción que ocurre antes de esa validación, así que relay aquí
        // SIEMPRE. El wrapper aisdk queda como capa defensiva: si alguna versión
        // futura sí enruta file-parts al pump, aquí ya reemplazamos los media
        // parts → el prompt convertido a v3 no tendrá file-parts → sin doble
        // análisis. (Solo se mantiene un log diagnóstico.)
        if (aisdkProviders.has(event.model.providerID)) {
          log(
            "debug",
            `model ${event.model.providerID}/${event.model.id} is aisdk-routed; relaying in context hook (opencode rejects images before the aisdk layer)`,
          )
        }

        const apiKey = await resolveApiKey(spec)
        if (apiKey === undefined) {
          log(
            "error",
            `images present but ${spec.apiKeyEnv} is not set (nor ${spec.apiKeyFile}) — replacing images with a notice`,
          )
          replaceMediaWithNotice(
            messages,
            `Vision relay: la variable de entorno ${spec.apiKeyEnv} no está definida ni existe el archivo ${spec.apiKeyFile}, así que esta imagen no se pudo analizar con ${providerLabel(spec)}.`,
          )
          return
        }

        const stats = await relayImages(messages, {
          options,
          sessionID: event.sessionID,
          cache: state.cache,
          cacheSet,
          analyze: async (dataUri) => analyzeImage(transportOptions(spec, apiKey, options), dataUri),
          log,
        })

        log(
          "debug",
          `relayed ${stats.analyzed}/${stats.total} images (skipped: ${stats.tooLarge} too large, ${stats.overLimit} over limit, ${stats.failed} failed)`,
        )
      } catch (error) {
        log("error", `unexpected error in context hook: ${errorMessage(error)}`)
      }
    })

    // Defensive layer: wraps AISDK language models (provider package
    // `aisdk:...`) in case a future opencode version routes image file-parts to
    // the aisdk pump (today it rejects them before dispatch for text-only
    // models, so the context hook above is the real path). If it ever fires,
    // the analysis streams live into the TUI reasoning panel while the vision
    // provider works, and the 190s dispatch timeout never aborts a large-image analysis.
    const aisdkRegistration = await ctx.aisdk.hook("language", (input) => {
      try {
        if (input.language === undefined) return
        if (!shouldProcessInfo(input.model)) {
          log("debug", `aisdk model ${input.model.providerID}/${input.model.modelID} handles images natively; not wrapping`)
          return
        }
        input.language = buildWrappedLanguage(input.language, {
          options,
          spec,
          shouldProcess: true,
          resolveApiKey: () => resolveApiKey(spec),
          cache: state.cache,
          cacheSet,
          cacheNamespace: `aisdk:${input.model.providerID}/${input.model.modelID}`,
          log,
        })
        log("debug", `wrapped aisdk model ${input.model.providerID}/${input.model.modelID} for live vision relay`)
      } catch (error) {
        log("error", `unexpected error in aisdk.language hook: ${errorMessage(error)}`)
      }
    })

    return async () => {
      await registration.dispose()
      await aisdkRegistration.dispose()
    }
  },
})
