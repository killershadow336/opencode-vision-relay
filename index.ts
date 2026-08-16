import { Plugin } from "@opencode-ai/plugin"
import type { ContentPart } from "@opencode-ai/ai"
import type { Model } from "@opencode-ai/schema/model"
import { readFile } from "node:fs/promises"
import { analyzeImage } from "./gemini.js"
import { isImageMime } from "./images.js"
import { buildWrappedLanguage } from "./live.js"
import { resolveOptions, type VisionRelayOptions } from "./options.js"
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
 * Resolves the Gemini API key at dispatch time. Order: env var (default
 * GOOGLE_AI_STUDIO_API_KEY) → fallback file (default
 * ~/.config/opencode/vision-relay.key). Reading the file fresh on each dispatch
 * makes the plugin resilient to service restarts, regardless of which process
 * spawned the service and what environment it inherited.
 */
async function resolveApiKey(options: VisionRelayOptions): Promise<string | undefined> {
  const fromEnv = process.env[options.apiKeyEnv]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  try {
    const fromFile = (await readFile(options.apiKeyFile, "utf8")).trim()
    return fromFile === "" ? undefined : fromFile
  } catch {
    return undefined
  }
}

export default Plugin.define({
  id: "opencode.vision-relay",
  setup: async (ctx) => {
    const options = resolveOptions(ctx.options, process.env)
    const log = (level: "debug" | "error", message: string): void => {
      if (level === "error") console.warn(`[vision-relay] ${message}`)
      else if (options.debug) console.log(`[vision-relay] ${message}`)
    }

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

        // AI SDK-routed models are handled by the aisdk.language wrapper, which
        // streams the analysis live into the reasoning panel. Skip them here so
        // the image file parts survive until the model dispatch.
        if (aisdkProviders.has(event.model.providerID)) {
          log("debug", `model ${event.model.providerID}/${event.model.id} is aisdk-routed; live relay via aisdk.language`)
          return
        }

        const apiKey = await resolveApiKey(options)
        if (apiKey === undefined) {
          log(
            "error",
            `images present but ${options.apiKeyEnv} is not set (nor ${options.apiKeyFile}) — replacing images with a notice`,
          )
          replaceMediaWithNotice(
            messages,
            `Vision relay: la variable de entorno ${options.apiKeyEnv} no está definida ni existe el archivo ${options.apiKeyFile}, así que esta imagen no se pudo analizar con Gemini.`,
          )
          return
        }

        const stats = await relayImages(messages, {
          options,
          sessionID: event.sessionID,
          cache: state.cache,
          cacheSet,
          analyze: async (dataUri) => analyzeImage({ ...options, apiKey }, dataUri),
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

    // Wraps AISDK language models (provider package `aisdk:...`) that are
    // text-only, so image analysis streams live into the TUI reasoning panel
    // while Gemini works, and the 60s (now 190s) dispatch timeout never aborts
    // a large-image analysis.
    const aisdkRegistration = await ctx.aisdk.hook("language", (input) => {
      try {
        if (input.language === undefined) return
        if (!shouldProcessInfo(input.model)) {
          log("debug", `aisdk model ${input.model.providerID}/${input.model.modelID} handles images natively; not wrapping`)
          return
        }
        input.language = buildWrappedLanguage(input.language, {
          options,
          shouldProcess: true,
          resolveApiKey: () => resolveApiKey(options),
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
