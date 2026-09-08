// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createNativeV2CredentialProbe } from "./native-credentials-v2"
import { createV2CredentialReadiness, credentialFixtureCatalogReady } from "./native-v2-readiness"

const endpoint = "http://127.0.0.1:32123/credential/v1"
const model = () => ({
  id: "fixture",
  providerID: "openai",
  api: { type: "aisdk", package: "@ai-sdk/openai-compatible", id: "fixture", url: endpoint, settings: {} },
  request: { headers: {}, body: {} },
})

async function fixture(
  variation: {
    endpoint?: string
    wrongModel?: boolean
    switchFails?: boolean
    promptFails?: boolean
    pendingIntegration?: number
  } = {},
) {
  // Actual probe nonce/auth logic with an inert in-memory V2 API. No provider,
  // native app, keyring, catalog network loading or hardware is started here.
  const probe = createNativeV2CredentialProbe({ providerID: "openai" })
  const state = {
    saved: false,
    canary: "",
    modelReads: 0,
    sessionReads: 0,
    switched: false,
    writes: [] as string[],
    delayed: false,
    pendingIntegration: variation.pendingIntegration ?? 0,
  }
  const request = async (route: string, init: { method: "GET" | "POST" | "DELETE"; body?: any }) => {
    if (init.method !== "GET") state.writes.push(route)
    if (route === "/api/integration/openai") {
      if (state.delayed && state.pendingIntegration-- > 0) return { location: { directory: "/owned/inert" } }
      return {
        data: {
          id: "openai",
          methods: [{ type: "key" }],
          connections: state.saved ? [{ type: "credential", id: "cred_inert" }] : [],
        },
      }
    }
    if (route === "/api/integration/openai/connect/key") {
      state.saved = true
      state.canary = init.body.key
      return undefined
    }
    if (route === "/api/model") {
      state.modelReads++
      const value = model()
      if (variation.endpoint) value.api.url = variation.endpoint
      return { data: state.delayed && state.modelReads < 3 ? [] : [value] }
    }
    if (route === "/api/session/ses_inert/model") {
      // Reproduces the missing-precondition bug: old direct dispatch reaches
      // this mutation before delayed catalog initialization has completed.
      if (state.modelReads < 3 || variation.switchFails) throw new Error("PRIVATE-NOT-READY")
      state.switched = true
      return undefined
    }
    if (route === "/api/session/ses_inert" && init.method === "GET") {
      state.sessionReads++
      return {
        data: {
          id: "ses_inert",
          model: {
            providerID: !variation.wrongModel && state.switched && state.sessionReads >= 2 ? "openai" : "fixture",
            id: "fixture",
          },
        },
      }
    }
    if (route === "/api/session/ses_inert/prompt") {
      if (state.sessionReads < 2 || variation.promptFails) throw new Error("PRIVATE-PROMPT-FAILURE")
      probe.observeProviderRequest({
        authorization: `Bearer ${state.canary}`,
        messages: [{ role: "user", content: init.body.prompt.text }],
      })
      return { data: { sessionID: "ses_inert" } }
    }
    throw new Error("PRIVATE-UNKNOWN-ROUTE")
  }
  await probe.save(request)
  state.writes = []
  state.delayed = true
  const readiness = createV2CredentialReadiness({
    request,
    probe,
    endpoint,
    sessionId: "ses_inert",
    timeoutMs: 40,
    pollMs: 1,
  })
  return { readiness, probe, state, request }
}

test("delayed actual catalog and model readback admit exactly one inert credential request", async () => {
  const f = await fixture()
  await expect(f.request("/api/session/ses_inert/model", { method: "POST" })).rejects.toThrow("PRIVATE-NOT-READY")
  f.state.writes = []
  await f.readiness.dispatch()
  expect(f.state.writes).toEqual(["/api/session/ses_inert/model", "/api/session/ses_inert/prompt"])
  expect(f.probe.finishObservation().authorizationMatched).toBe(true)
  expect(f.readiness.checkpoint()).toEqual({
    catalogReads: 4,
    sessionReads: 2,
    savedConnectionReady: true,
    catalogReady: true,
    selectedModelReady: true,
    modelSwitches: 1,
    prompts: 1,
  })
  expect(JSON.stringify(f.readiness.checkpoint())).not.toContain(f.state.canary)
  expect(JSON.stringify(f.readiness.checkpoint())).not.toContain(endpoint)
  await expect(f.readiness.dispatch()).rejects.toThrow("V2_CREDENTIAL_PROBE_DISPATCH_UNCONFIRMED")
  expect(f.state.writes).toHaveLength(2)
})

test("restart waits for initially absent integration registration before switching or prompting once", async () => {
  const f = await fixture({ pendingIntegration: 2 })
  await f.readiness.dispatch()
  expect(f.state.writes).toEqual(["/api/session/ses_inert/model", "/api/session/ses_inert/prompt"])
  expect(f.probe.finishObservation().authorizationMatched).toBe(true)
  expect(f.readiness.checkpoint().savedConnectionReady).toBe(true)
  await expect(f.readiness.dispatch()).rejects.toThrow("DISPATCH_UNCONFIRMED")
  expect(f.state.writes).toHaveLength(2)
})

test("wrong endpoint, SDK, fallback key, duplicate model or absent catalog never authorizes the prompt", async () => {
  expect(credentialFixtureCatalogReady({ data: [] }, endpoint)).toBe(false)
  expect(credentialFixtureCatalogReady({ data: [model()] }, endpoint)).toBe(true)
  for (const changed of [
    { ...model(), api: { ...model().api, url: "https://api.openai.com/v1" } },
    { ...model(), api: { ...model().api, package: "@ai-sdk/openai" } },
    { ...model(), api: { ...model().api, settings: { apiKey: "INERT-BYPASS" } } },
    { ...model(), request: { headers: { Authorization: "INERT-BYPASS" }, body: {} } },
  ])
    expect(credentialFixtureCatalogReady({ data: [changed] }, endpoint)).toBe(false)
  expect(() => credentialFixtureCatalogReady({ data: [model(), model()] }, endpoint)).toThrow("CATALOG_UNCONFIRMED")
  const f = await fixture({ endpoint: "https://api.openai.com/v1" })
  await expect(f.readiness.dispatch()).rejects.toThrow("V2_CREDENTIAL_PROBE_CATALOG_UNCONFIRMED")
  expect(f.state.writes).toEqual([])
  expect(f.probe.observationReady()).toBe(false)
})

test("wrong selected model or failed mutation cannot be retried into a credential proof", async () => {
  for (const variation of [{ wrongModel: true }, { switchFails: true }, { promptFails: true }]) {
    const f = await fixture(variation)
    await expect(f.readiness.dispatch()).rejects.toThrow()
    await expect(f.readiness.dispatch()).rejects.toThrow("V2_CREDENTIAL_PROBE_DISPATCH_UNCONFIRMED")
    expect(f.state.writes.filter((route) => route.endsWith("/model"))).toHaveLength(1)
    expect(f.state.writes.filter((route) => route.endsWith("/prompt"))).toHaveLength(variation.promptFails ? 1 : 0)
  }
})
