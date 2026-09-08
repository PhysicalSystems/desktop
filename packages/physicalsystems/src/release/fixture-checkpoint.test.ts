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
  expect(result.length).toBeLessThan(1000)
})

test("approval checkpoints preserve supplied admission and trial state without recording their identities", () => {
  const trap = "PRIVATE_PLAN_ID_TOKEN_TEXT"
  const result = fixtureCheckpointDetail({
    calls: [
      { tool: "inspect_local_experiment", response: trap },
      { tool: "propose_local_experiment", arguments: trap },
      { tool: "run_simulated_trial", arguments: trap },
      { tool: "run_simulated_trial", arguments: trap },
      { tool: "finish_local_experiment", response: trap },
    ],
    renderer: {
      observed: true,
      phase: "READY",
      sameExperiment: true,
      samePlan: false,
      trialCount: 2,
      completedTrials: 1,
      failedTrials: 1,
      continuationState: "UNCONFIRMED",
      conversationBusy: true,
      continuationVisible: true,
      approvalDisabled: false,
      continuationDisabled: true,
      experimentId: trap,
      planDigest: trap,
      continuation: { requestId: trap, error: trap },
      transcript: trap,
      endpoint: trap,
      error: trap,
    },
  })
  const value = JSON.parse(result.slice("Synthetic fixture checkpoint: ".length))
  expect(value).toMatchObject({
    providerResponses: 5,
    inspectResponses: 1,
    proposalResponses: 1,
    trialResponses: 2,
    finishResponses: 1,
    rendererObserved: true,
    phase: "READY",
    sameExperiment: true,
    samePlan: false,
    trialCount: 2,
    completedTrials: 1,
    failedTrials: 1,
    continuationState: "UNCONFIRMED",
    conversationBusy: true,
    continuationVisible: true,
    approvalDisabled: false,
    continuationDisabled: true,
  })
  expect(result).not.toContain(trap)
  for (const state of ["PENDING", "UNCONFIRMED", "ACCEPTED"])
    expect(fixtureCheckpointDetail({ calls: [], renderer: { continuationState: state } })).toContain(
      `"continuationState":"${state}"`,
    )
})

test("approval checkpoint additions accept only bounded counts, literal states and exact booleans", () => {
  const trap = "PRIVATE_CHECKPOINT_CANARY"
  const object = {
    toString() {
      throw new Error(trap)
    },
  }
  const value = JSON.parse(
    fixtureCheckpointDetail({
      calls: [{ tool: "finish_local_experiment" }, { tool: trap }],
      renderer: {
        phase: object,
        continuationState: object,
        sameExperiment: trap,
        samePlan: 1,
        conversationBusy: "true",
        continuationVisible: object,
        approvalDisabled: trap,
        continuationDisabled: [],
        trialCount: 1000000,
        completedTrials: -1,
        failedTrials: object,
      },
    }).slice("Synthetic fixture checkpoint: ".length),
  )
  expect(value).toMatchObject({
    phase: "NONE_OR_UNKNOWN",
    continuationState: "NONE_OR_UNKNOWN",
    finishResponses: 1,
    sameExperiment: false,
    samePlan: false,
    conversationBusy: false,
    continuationVisible: false,
    approvalDisabled: false,
    continuationDisabled: false,
    trialCount: 10000,
    completedTrials: 0,
    failedTrials: 0,
  })
  expect(JSON.stringify(value)).not.toContain(trap)
  for (const invalid of [Infinity, NaN, -2, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"])
    expect(
      fixtureCheckpointDetail({
        calls: [],
        renderer: { trialCount: invalid, completedTrials: invalid, failedTrials: invalid },
      }),
    ).toContain('"trialCount":0,"completedTrials":0,"failedTrials":0')
  for (const phase of ["INTERRUPTED", "OUTCOME_UNKNOWN"])
    expect(fixtureCheckpointDetail({ calls: [], renderer: { phase } })).toContain(`"phase":"${phase}"`)
})
