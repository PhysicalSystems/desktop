// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createNativeV2CredentialProbe } from "./native-credentials-v2"
import {
  createV2CredentialReadiness,
  createV2RemovalReadiness,
  credentialFixtureCatalogReady,
} from "./native-v2-readiness"

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
    if (route === "/api/credential/cred_inert" && init.method === "DELETE") {
      state.saved = false
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

test("restart does not query the dependent catalog before its saved connection is registered", async () => {
  const f = await fixture()
  let integrations = 0
  let registered = false
  let catalogs = 0
  const request = async (route: string, init: Parameters<typeof f.request>[1]) => {
    if (route === "/api/integration/openai") {
      registered = ++integrations > 2
      if (!registered) return { location: { directory: "/owned/inert" }, data: null }
    }
    if (route === "/api/model") {
      catalogs++
      if (!registered) throw Error("INERT_CATALOG_REQUESTED_BEFORE_REGISTRATION")
    }
    return f.request(route, init)
  }
  const readiness = createV2CredentialReadiness({
    request,
    probe: f.probe,
    endpoint,
    sessionId: "ses_inert",
    timeoutMs: 100,
    pollMs: 1,
  })
  await readiness.dispatch()
  expect(integrations).toBe(6)
  expect(catalogs).toBe(4)
  expect(readiness.checkpoint().catalogReads).toBe(catalogs)
  expect(f.state.writes).toEqual(["/api/session/ses_inert/model", "/api/session/ses_inert/prompt"])
  expect(f.probe.finishObservation().authorizationMatched).toBe(true)
})

test("unregistered connection times out without catalog requests; a registered malformed catalog still fails", async () => {
  for (const registered of [false, true]) {
    const f = await fixture()
    let catalogs = 0
    const request = async (route: string, init: Parameters<typeof f.request>[1]) => {
      if (!registered && route === "/api/integration/openai")
        return { location: { directory: "/owned/inert" }, data: null }
      if (route === "/api/model") {
        catalogs++
        throw Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
      }
      return f.request(route, init)
    }
    const readiness = createV2CredentialReadiness({
      request,
      probe: f.probe,
      endpoint,
      sessionId: "ses_inert",
      timeoutMs: 20,
      pollMs: 1,
    })
    await expect(readiness.dispatch()).rejects.toThrow(registered ? "AUTH_UNCONFIRMED" : "CATALOG_UNCONFIRMED")
    expect(catalogs).toBe(registered ? 1 : 0)
    expect(readiness.checkpoint().catalogReady).toBe(false)
    expect(f.state.writes).toEqual([])
    await expect(readiness.dispatch()).rejects.toThrow("DISPATCH_UNCONFIRMED")
  }
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

test("third process waits for registered disconnection and actual inert catalog before strict absence assertion", async () => {
  const f = await fixture()
  await f.probe.remove(f.request)
  f.state.writes = []
  const fixtureEndpoint = "http://127.0.0.1:32123/v1"
  let integrations = 0,
    catalogs = 0
  const request = async (route: string, init: { method: "GET" | "POST" | "DELETE" }) => {
    expect(init.method).toBe("GET")
    if (route === "/api/integration/openai" && ++integrations <= 2)
      return { location: { directory: "/owned/inert" }, data: integrations === 1 ? null : undefined }
    if (route === "/api/model")
      return {
        data:
          ++catalogs <= 2
            ? []
            : [
                {
                  ...model(),
                  providerID: "fixture",
                  api: { ...model().api, url: fixtureEndpoint },
                },
              ],
      }
    return f.request(route, init)
  }
  const readiness = createV2RemovalReadiness({
    request,
    probe: f.probe,
    endpoint: fixtureEndpoint,
    timeoutMs: 100,
    pollMs: 1,
  })
  await readiness.wait()
  expect(readiness.checkpoint()).toEqual({
    integrationReads: 5,
    catalogReads: 3,
    disconnectedReady: true,
    catalogReady: true,
  })
  expect((await f.probe.assertRemoved(request)).credentialAbsent).toBe(true)
  expect(f.state.writes).toEqual([])
})

test("uninitialized, malformed, reconnected or foreign catalog cannot establish removal or repeat DELETE", async () => {
  const fixtureEndpoint = "http://127.0.0.1:32123/v1"
  for (const variation of [
    "pending",
    "empty",
    "credential",
    "env",
    "malformed",
    "http",
    "wrong-endpoint",
    "still-available",
    "duplicate",
  ]) {
    const f = await fixture()
    await f.probe.remove(f.request)
    f.state.writes = []
    let requests = 0
    const request = async (route: string, init: { method: "GET" | "POST" | "DELETE" }) => {
      requests++
      expect(init.method).toBe("GET")
      if (route === "/api/integration/openai") {
        if (variation === "pending") return { location: { directory: "/owned/inert" }, data: null }
        if (variation === "http") throw Error("PRIVATE-HTTP-FAILURE")
        if (["credential", "env", "malformed"].includes(variation))
          return {
            data: {
              id: "openai",
              connections:
                variation === "credential"
                  ? [{ type: "credential", id: "cred_unexpected" }]
                  : variation === "env"
                    ? [{ type: "env", name: "PRIVATE_ENV" }]
                    : null,
            },
          }
        return f.request(route, init)
      }
      const value = { ...model(), providerID: "fixture", api: { ...model().api, url: fixtureEndpoint } }
      if (variation === "wrong-endpoint") value.api.url = "https://external.example"
      return {
        data:
          variation === "empty"
            ? []
            : variation === "still-available"
              ? [model()]
              : variation === "duplicate"
                ? [value, value]
                : [value],
      }
    }
    const readiness = createV2RemovalReadiness({
      request,
      probe: f.probe,
      endpoint: fixtureEndpoint,
      timeoutMs: 20,
      pollMs: 1,
    })
    await expect(readiness.wait()).rejects.toThrow("REMOVAL_UNCONFIRMED")
    expect(f.state.writes).toEqual([])
    expect(readiness.checkpoint().catalogReady).toBe(false)
    if (!["pending", "empty"].includes(variation)) expect(requests).toBeLessThanOrEqual(2)
  }
})
