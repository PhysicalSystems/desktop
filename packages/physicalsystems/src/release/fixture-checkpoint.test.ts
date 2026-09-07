// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { fixtureCheckpointDetail } from "./fixture-checkpoint"

test("proposal checkpoints distinguish missing provider work, emitted tools and UI state", () => {
  const result = fixtureCheckpointDetail({
    calls: [{ tool: null }, { tool: "inspect_local_experiment" }, { tool: "propose_local_experiment" }],
    renderer: {
      observed: true,
      projectSelected: true,
      conversationBound: true,
      phase: "PROPOSED",
      approvalVisible: false,
      userMessages: 1,
      alerts: 0,
    },
  })
  expect(result).toContain('"providerResponses":3')
  expect(result).toContain('"inspectResponses":1')
  expect(result).toContain('"proposalResponses":1')
  expect(result).toContain('"conversationBound":true')
  expect(result).toContain('"phase":"PROPOSED"')
  expect(result).toContain('"approvalVisible":false')
  const absent = fixtureCheckpointDetail({ calls: [], renderer: undefined })
  expect(absent).toContain('"providerResponses":0')
  expect(absent).toContain('"rendererObserved":false')
})

test("checkpoint projection never echoes untrusted messages, IDs, URLs, credentials or arbitrary phases", () => {
  const trap = "qualification-credential-trap"
  const result = fixtureCheckpointDetail({
    calls: [
      { tool: trap, arguments: trap, text: trap, url: trap },
      { tool: "propose_local_experiment", text: trap },
    ],
    renderer: {
      observed: trap,
      projectSelected: trap,
      conversationBound: trap,
      phase: trap,
      token: trap,
      url: trap,
      experimentError: trap,
      userMessages: trap,
      alerts: 1000000,
      transcript: trap,
    },
  })
  expect(result).not.toContain(trap)
  expect(result).toContain('"phase":"NONE_OR_UNKNOWN"')
  expect(result).toContain('"proposalResponses":1')
  expect(result).toContain('"alerts":10000')
  expect(result).toContain('"userMessages":0')
  expect(result.length).toBeLessThan(550)
})
