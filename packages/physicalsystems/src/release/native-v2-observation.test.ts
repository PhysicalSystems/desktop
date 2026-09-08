// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createV2TransportObservation } from "./native-v2-observation"

test("V2 checkpoint retains only immutable fixed fields, never credential-bearing transport values", () => {
  const observation = createV2TransportObservation()
  expect(observation.snapshot()).toBeUndefined()
  const input = {
    routeKind: "key-write",
    method: "POST",
    status: 204,
    outcome: "accepted",
    url: "http://private.invalid/PRIVATE-TOKEN",
    body: { key: "PRIVATE-CREDENTIAL" },
    headers: { Authorization: "PRIVATE-AUTH" },
    error: new Error("PRIVATE-ERROR"),
  }
  observation.observe(input)
  input.status = 500
  input.outcome = "rejected"
  expect(observation.snapshot()).toEqual({ routeKind: "key-write", method: "POST", status: 204, outcome: "accepted" })
  expect(Object.isFrozen(observation.snapshot())).toBe(true)
  expect(JSON.stringify(observation.snapshot())).not.toContain("PRIVATE")
  observation.observe({ routeKind: "integration", method: "GET", outcome: "pending" })
  expect(observation.snapshot()).toEqual({ routeKind: "integration", method: "GET", outcome: "pending" })
  observation.observe({
    routeKind: "integration",
    method: "GET",
    outcome: "rejected",
    status: 200,
    envelopeValid: true,
    locationMatched: false,
  })
  expect(observation.snapshot()).toEqual({
    routeKind: "integration",
    method: "GET",
    outcome: "rejected",
    status: 200,
    envelopeValid: true,
    locationMatched: false,
  })
})

test("invalid V2 observations clear stale success and fail with only an authored error", () => {
  for (const change of [
    { routeKind: "PRIVATE-URL" },
    { routeKind: "__proto__" },
    { method: "POST" },
    { status: "200 PRIVATE" },
    { status: 99 },
    { status: 600 },
    { status: 200.5 },
    { status: NaN },
    { outcome: "PRIVATE-ERROR" },
    { envelopeValid: "PRIVATE-BODY" },
    { locationMatched: "/private/location" },
  ]) {
    const observation = createV2TransportObservation()
    const good = { routeKind: "catalog", method: "GET", outcome: "accepted", status: 200 }
    observation.observe(good)
    expect(() => observation.observe({ ...good, ...change })).toThrow("V2_CREDENTIAL_PROBE_OBSERVATION_INVALID")
    expect(observation.snapshot()).toBeUndefined()
  }
  for (const value of [null, [], "PRIVATE", 1, undefined]) {
    expect(() => createV2TransportObservation().observe(value)).toThrow("V2_CREDENTIAL_PROBE_OBSERVATION_INVALID")
  }
})
