// SPDX-License-Identifier: Apache-2.0
import type { createNativeV2CredentialProbe } from "./native-credentials-v2"
import type { ownedV2CredentialTransport } from "./native-v2-transport"

const fail = (boundary: string) => new Error(`V2_CREDENTIAL_PROBE_${boundary}_UNCONFIRMED`)
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Catalog APIs can start before location plugins finish. A model name alone
 * cannot authorize the inert request: its actual endpoint/package must match. */
export function credentialFixtureCatalogReady(result: unknown, endpoint: string, provider: unknown) {
  if (!record(result) || !Array.isArray(result.data)) throw fail("CATALOG")
  const matches = result.data.filter((value: unknown) => {
    if (!record(value) || typeof value.id !== "string" || typeof value.providerID !== "string") throw fail("CATALOG")
    return value.id === "fixture" && value.providerID === "openai"
  })
  if (matches.length > 1) throw fail("CATALOG")
  if (!matches.length) return false
  const model = matches[0]
  return fixtureRouteReady(model, provider, "openai", endpoint, true)
}

function fixtureRouteReady(model: Record<string, any>, result: unknown, providerID: string, endpoint: string, credentialOnly: boolean) {
  if (!record(result) || !record(result.data) || result.data.id !== providerID) return false
  const provider = result.data
  if (model.enabled !== true || model.modelID !== "fixture" || (model.package ?? provider.package) !== "@opencode/ai/providers/openai-compatible" ||
    (model.settings?.baseURL ?? provider.settings?.baseURL) !== endpoint) return false
  if (credentialOnly && provider.integrationID !== undefined && provider.integrationID !== providerID) return false
  const overlays = [provider, model, ...(Array.isArray(model.variants) ? model.variants : [])]
  return overlays.every((item) => {
    if (!record(item)) return false
    if ([item.settings, item.headers, item.body].some((value) => value !== undefined && !record(value))) return false
    if (item.package !== undefined && item.package !== "@opencode/ai/providers/openai-compatible") return false
    if (item.settings?.baseURL !== undefined && item.settings.baseURL !== endpoint) return false
    if (!credentialOnly) return true
    return item.settings?.apiKey === undefined && item.settings?.auth === undefined && item.body?.apiKey === undefined &&
      item.settings?.headers === undefined && item.settings?.body === undefined &&
      !Object.keys(item.headers ?? {}).some((key) => /^(authorization|x-api-key)$/i.test(key))
  })
}

/** One model switch and one nonce prompt, only after actual restart readiness.
 * Readback retries are bounded; mutations are never retried or duplicated. */
export function createV2CredentialReadiness(input: {
  request: ReturnType<typeof ownedV2CredentialTransport>
  probe: ReturnType<typeof createNativeV2CredentialProbe>
  sessionId: string
  endpoint: string
  timeoutMs?: number
  pollMs?: number
}) {
  if (
    input.probe.providerID !== "openai" ||
    !/^ses_[a-zA-Z0-9_-]{1,252}$/.test(input.sessionId) ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/credential\/v1$/.test(input.endpoint) ||
    Number(input.endpoint.split(":")[2]?.split("/")[0]) > 65535
  )
    throw fail("CATALOG")
  const timeoutMs = input.timeoutMs ?? 15000
  const pollMs = input.pollMs ?? 50
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 100
  )
    throw fail("CATALOG")
  const state = {
    catalogReads: 0,
    sessionReads: 0,
    savedConnectionReady: false,
    catalogReady: false,
    selectedModelReady: false,
    modelSwitches: 0,
    prompts: 0,
  }
  let started = false
  const route = `/api/session/${input.sessionId}`
  const readCatalog = async () => {
    state.catalogReady = false
    state.savedConnectionReady = await input.probe.savedConnectionReady(input.request)
    // A restarted Location can expose routes before the saved integration is
    // registered. Wait for that prerequisite before reading its model catalog.
    if (!state.savedConnectionReady) return false
    state.catalogReads++
    state.catalogReady = credentialFixtureCatalogReady(
      await input.request("/api/model", { method: "GET" }),
      input.endpoint,
      await input.request("/api/provider/openai", { method: "GET" }),
    )
    return state.savedConnectionReady && state.catalogReady
  }
  return {
    checkpoint: () => ({ ...state }),
    async dispatch() {
      if (started) throw fail("DISPATCH")
      started = true
      const deadline = Date.now() + timeoutMs
      const wait = async (read: () => Promise<boolean>, boundary: string) => {
        while (Date.now() < deadline) {
          if (await read()) return
          await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
        }
        throw fail(boundary)
      }
      await wait(readCatalog, "CATALOG")
      state.modelSwitches++
      await input.request(route + "/model", {
        method: "POST",
        body: { model: { providerID: "openai", id: "fixture" } },
      })
      await wait(async () => {
        state.sessionReads++
        const result = await input.request(route, { method: "GET" })
        if (!record(result) || !record(result.data) || result.data.id !== input.sessionId) throw fail("MODEL")
        const model = result.data.model
        state.selectedModelReady =
          model?.providerID === "openai" &&
          model.id === "fixture" &&
          (model.variant === undefined || model.variant === "default")
        return state.selectedModelReady
      }, "MODEL")
      // Readiness must still hold immediately before admitting the single prompt.
      if (!(await readCatalog())) throw fail("CATALOG")
      const prompt = input.probe.beginObservation("present")
      state.prompts++
      await input.request(route + "/prompt", { method: "POST", body: { text: prompt } })
    },
  }
}

/** Third-process readiness before the separate strict removal assertion. Only
 * read-only registration/catalog absence is retryable; no auth mutation occurs. */
export function createV2RemovalReadiness(input: {
  request: ReturnType<typeof ownedV2CredentialTransport>
  probe: ReturnType<typeof createNativeV2CredentialProbe>
  endpoint: string
  timeoutMs?: number
  pollMs?: number
}) {
  const timeoutMs = input.timeoutMs ?? 15000
  const pollMs = input.pollMs ?? 50
  if (
    input.probe.providerID !== "openai" ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/.test(input.endpoint) ||
    Number(input.endpoint.split(":")[2]?.split("/")[0]) > 65535 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 100
  )
    throw fail("REMOVAL")
  const state = { integrationReads: 0, catalogReads: 0, disconnectedReady: false, catalogReady: false }
  return {
    checkpoint: () => ({ ...state }),
    async wait() {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        state.integrationReads++
        state.disconnectedReady = await input.probe.removedConnectionReady(input.request)
        state.catalogReady = false
        if (state.disconnectedReady) {
          state.catalogReads++
          const result = await input.request("/api/model", { method: "GET" })
          if (!record(result) || !Array.isArray(result.data)) throw fail("REMOVAL")
          const matches = result.data.filter((value: unknown) => {
            if (
              !record(value) ||
              typeof value.id !== "string" ||
              typeof value.providerID !== "string" ||
              value.providerID === "openai"
            )
              throw fail("REMOVAL")
            return value.id === "fixture" && value.providerID === "fixture"
          })
          if (matches.length > 1) throw fail("REMOVAL")
          if (matches.length) {
            const model = matches[0]
            if (!fixtureRouteReady(model, await input.request("/api/provider/fixture", { method: "GET" }), "fixture", input.endpoint, false))
              throw fail("REMOVAL")
            state.catalogReady = true
            return
          }
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
      }
      throw fail("REMOVAL")
    },
  }
}
