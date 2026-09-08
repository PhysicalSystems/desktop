// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { ownedV2CredentialTransport } from "./native-v2-transport"

const attachment = {
  url: "http://127.0.0.1:32123",
  username: "fixture",
  password: "inert-only",
  directory: "/owned/a space",
  sessionId: "ses_fixture",
}

test("V2 transport binds exact owned location, routes, auth, response envelope and HTTP204", async () => {
  const calls: { url: URL; init?: RequestInit }[] = []
  const transport = ownedV2CredentialTransport(attachment, async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (init?.method !== "GET") return new Response(null, { status: 204 })
    return Response.json({ location: { directory: attachment.directory }, data: { id: "openai", connections: [] } })
  })
  expect(await transport("/api/integration/openai", { method: "GET" })).toEqual({
    location: { directory: attachment.directory },
    data: { id: "openai", connections: [] },
  })
  expect(
    await transport("/api/integration/openai/connect/key", {
      method: "POST",
      body: { key: "fixture-canary", label: "fixture" },
    }),
  ).toBeUndefined()
  for (const { url, init } of calls) {
    expect(url.origin).toBe(attachment.url)
    expect(url.searchParams.get("location[directory]")).toBe(attachment.directory)
    expect(url.searchParams.has("directory")).toBe(false)
    expect(init?.redirect).toBe("error")
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from("fixture:inert-only").toString("base64"),
    )
  }
  await expect(transport("/api/session/ses_foreign/model", { method: "POST" })).rejects.toThrow(
    "V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED",
  )
  expect(calls).toHaveLength(2)
})

test("V2 transport refuses malformed, redirected, foreign-location and unbounded responses", async () => {
  for (const response of [
    Response.json({ data: [] }),
    Response.json({ location: { directory: "/foreign" }, data: [] }),
    Response.json({ location: { directory: attachment.directory, workspaceID: "foreign" }, data: [] }),
    new Response("PRIVATE_FAILURE", { status: 503 }),
    new Response(null, { status: 302 }),
    new Response("{"),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const transport = ownedV2CredentialTransport(attachment, async () => response)
    await expect(transport("/api/model", { method: "GET" })).rejects.toThrow("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
  }
  const transport = ownedV2CredentialTransport(attachment, async () => Response.json({ data: true }))
  await expect(transport("/api/credential/cred_fixture", { method: "DELETE" })).rejects.toThrow(
    "V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED",
  )
  expect(() => ownedV2CredentialTransport({ ...attachment, url: "https://example.com" })).toThrow(
    "V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED",
  )
})

test("integration UndefinedOr wire encoding alone permits omitted data with the exact owned location", async () => {
  // The actual GET contract is Location.response(UndefinedOr(Integration.Info));
  // pinned Effect HttpApiBuilder serializes that value with JSON.stringify.
  const wire = JSON.stringify({ location: { directory: attachment.directory }, data: undefined })
  expect(JSON.parse(wire)).not.toHaveProperty("data")
  const transport = ownedV2CredentialTransport(attachment, async () => new Response(wire))
  expect(await transport("/api/integration/openai", { method: "GET" })).toEqual({
    location: { directory: attachment.directory },
  })
  for (const route of ["/api/model", "/api/session/active", "/api/session/" + attachment.sessionId])
    await expect(transport(route, { method: "GET" })).rejects.toThrow("AUTH_UNCONFIRMED")
  for (const location of [
    undefined,
    { directory: "/foreign" },
    { directory: attachment.directory, workspaceID: "foreign" },
  ]) {
    const rejected = ownedV2CredentialTransport(attachment, async () => Response.json({ location }))
    await expect(rejected("/api/integration/openai", { method: "GET" })).rejects.toThrow("AUTH_UNCONFIRMED")
  }
})

test("V2 readback accepts only the exact owned session ID and its persisted location", async () => {
  const route = "/api/session/" + attachment.sessionId
  const value = {
    id: attachment.sessionId,
    location: { directory: attachment.directory },
    model: { providerID: "openai", id: "fixture" },
  }
  const transport = ownedV2CredentialTransport(attachment, async () => Response.json({ data: value }))
  expect(await transport(route, { method: "GET" })).toEqual({ data: value })
  await expect(transport("/api/session/ses_foreign", { method: "GET" })).rejects.toThrow("AUTH_UNCONFIRMED")
  for (const data of [
    { ...value, id: "ses_foreign" },
    { ...value, location: { directory: "/foreign" } },
    { ...value, location: { ...value.location, workspaceID: "foreign" } },
  ]) {
    const rejected = ownedV2CredentialTransport(attachment, async () => Response.json({ data }))
    await expect(rejected(route, { method: "GET" })).rejects.toThrow("AUTH_UNCONFIRMED")
  }
})

test("real transport records only the failed method/status and envelope/location boundary", async () => {
  const { createV2TransportObservation } = await import("./native-v2-observation")
  const observation = createV2TransportObservation()
  const failed = ownedV2CredentialTransport(
    attachment,
    async () => new Response("PRIVATE-UPSTREAM-BODY", { status: 504 }),
    observation,
  )
  await expect(
    failed("/api/integration/openai/connect/key", { method: "POST", body: { key: "PRIVATE-CANARY" } }),
  ).rejects.toThrow("AUTH_UNCONFIRMED")
  expect(observation.snapshot()).toEqual({ routeKind: "key-write", method: "POST", status: 504, outcome: "rejected" })
  const foreign = ownedV2CredentialTransport(
    attachment,
    async () => Response.json({ data: [], location: { directory: "PRIVATE-FOREIGN" } }),
    observation,
  )
  await expect(foreign("/api/model", { method: "GET" })).rejects.toThrow("AUTH_UNCONFIRMED")
  expect(observation.snapshot()).toEqual({
    routeKind: "catalog",
    method: "GET",
    status: 200,
    envelopeValid: true,
    locationMatched: false,
    outcome: "rejected",
  })
  expect(JSON.stringify(observation.snapshot())).not.toContain("PRIVATE")
  expect(JSON.stringify(observation.snapshot())).not.toContain(attachment.url)
})
