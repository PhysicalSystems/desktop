// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { agentState } from "./agent-status"

test("continuation waits through busy, retry and unknown connection state", () => {
  expect(agentState({ s: { type: "busy" } }, "s").busy).toBe(true)
  expect(agentState({ s: { type: "retry" } }, "s").busy).toBe(true)
  expect(agentState(undefined, "s").busy).toBe(true)
  expect(agentState({ s: { type: "future" } }, "s").busy).toBe(true)
  expect(agentState({ other: { type: "busy" } }, "s").busy).toBe(false)
  expect(agentState({ s: { type: "idle" } }, "s")).toEqual({ busy: false, error: null })
})

test("malformed status envelopes and foreign entries cannot make an absent session idle", () => {
  for (const status of [
    { data: {} },
    { error: "PRIVATE_PROVIDER_DETAIL" },
    { ok: true },
    { other: null },
    { other: { type: "retry" } },
    { s: { type: "idle" }, other: { type: "future" } },
  ]) {
    const next = agentState(status, "s")
    expect(next.busy).toBe(true)
    expect(next.error).not.toBeNull()
    expect(JSON.stringify(next)).not.toContain("PRIVATE_PROVIDER_DETAIL")
  }
})

test("a complete valid map distinguishes idle from busy and retry without inheriting session keys", () => {
  expect(agentState({}, "s")).toEqual({ busy: false, error: null })
  expect(agentState({}, "constructor")).toEqual({ busy: false, error: null })
  const retry = {
    type: "retry",
    attempt: 1,
    next: 0,
    message: "retry",
    action: { reason: "reason", provider: "provider", title: "title", message: "message", label: "label" },
  }
  expect(agentState({ other: retry }, "s")).toEqual({ busy: false, error: null })
  expect(agentState({ s: retry }, "s")).toEqual({ busy: true, error: null })
  for (const invalid of [
    { ...retry, attempt: -1 },
    { ...retry, next: Number.MAX_SAFE_INTEGER + 1 },
    { ...retry, message: null },
    { ...retry, action: null },
    { ...retry, action: { ...retry.action, link: null } },
  ]) {
    expect(agentState({ other: invalid }, "s").busy).toBe(true)
    expect(agentState({ other: invalid }, "s").error).not.toBeNull()
  }
})
