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
