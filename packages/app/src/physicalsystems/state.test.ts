// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test"
import {
  acceptsSnapshot,
  continuationRequest,
  cameraFresh,
  cameraIdentity,
  executionFresh,
  experimentExpired,
  trustedExperiment,
} from "./state"
import type { PhysicalExperiment, PhysicalSnapshot, PhysicalToolReference, PhysicalWorkcell } from "./types"

const experiment: PhysicalExperiment = {
  id: "experiment-1",
  goal: "Synthetic alignment",
  phase: "PROPOSED",
  planDigest: "digest-1",
  trialLimit: 4,
  expiresAt: 2000,
  trials: [],
}
const reference: PhysicalToolReference = {
  projectId: "project-1",
  conversationId: "conversation-1",
  serverId: "sidecar",
  sessionId: "session-1",
  experimentId: experiment.id,
  planDigest: experiment.planDigest,
}
const snapshot = (): PhysicalSnapshot => ({
  revision: 3,
  serviceId: "service-1",
  activeProjectId: "project-1",
  activeConversationId: "conversation-1",
  connectionGeneration: 2,
  projects: [
    {
      id: "project-1",
      name: "Test",
      connection: {
        kind: "simulation",
        label: "Fixture",
        status: "offline",
        observedAt: null,
        deviceCount: null,
        inUseCount: null,
      },
      conversations: [{ id: "conversation-1", title: "Fixture", sessionId: "session-1", serverId: "sidecar" }],
    },
  ],
  conversation: { id: "conversation-1", title: "Fixture", sessionId: "session-1", serverId: "sidecar" },
  workcell: null,
  setupReport: null,
  experiments: { availability: "simulation-only", current: experiment },
  activeRuns: [],
  activeCaptures: [],
  activeExperiments: [],
})
const camera = (): NonNullable<PhysicalWorkcell["camera"]> => ({
  availability: "available",
  receivedAt: 1000,
  previewFrameId: "frame-1",
  status: {
    phase: "live",
    frameFresh: true,
    frameAgeMs: 200,
    staleAfterMs: 1000,
    selectedCandidateId: "camera-1",
    captureSessionId: "capture-1",
  },
  frame: {
    candidateId: "camera-1",
    candidateDigest: "candidate-digest",
    captureSessionId: "capture-1",
    capture: { clockSessionId: "clock-1" },
    source: { hardwareIdentity: "device-1", kind: "synthetic", identityStability: "stable" },
  },
})

describe("trusted Physical Systems snapshots", () => {
  test("out-of-order replies and a replacement service cannot erase known ownership", () => {
    expect(acceptsSnapshot(snapshot(), { ...snapshot(), revision: 2 })).toBe(false)
    expect(acceptsSnapshot(snapshot(), { ...snapshot(), serviceId: "replacement" })).toBe(false)
    expect(acceptsSnapshot(snapshot(), { ...snapshot(), revision: 4 })).toBe(true)
    expect(acceptsSnapshot(undefined, snapshot())).toBe(true)
  })
  test("tool text cannot turn into an approval reference", () => {
    expect(trustedExperiment(snapshot(), JSON.stringify(reference), "session-1", "sidecar")).toBeUndefined()
    expect(
      trustedExperiment(snapshot(), { ...reference, planDigest: "invented" }, "session-1", "sidecar"),
    ).toBeUndefined()
    expect(
      trustedExperiment(snapshot(), { ...reference, experimentId: "unrelated" }, "session-1", "sidecar"),
    ).toBeUndefined()
  })
  test("the real tool session and current server must match the service binding", () => {
    expect(trustedExperiment(snapshot(), reference, "session-1", "sidecar")).toBe(experiment)
    expect(trustedExperiment(snapshot(), reference, "session-2", "sidecar")).toBeUndefined()
    expect(trustedExperiment(snapshot(), reference, "session-1", "other-server")).toBeUndefined()
    expect(
      trustedExperiment(snapshot(), { ...reference, conversationId: "other" }, "session-1", "sidecar"),
    ).toBeUndefined()
    expect(trustedExperiment(snapshot(), reference, undefined, "sidecar")).toBeUndefined()
  })
  test("history does not substitute a newer proposal for an old tool reference", () => {
    const value = snapshot()
    value.experiments = {
      availability: "simulation-only",
      current: { ...experiment, id: "new", planDigest: "new-digest" },
      history: [experiment],
    }
    expect(trustedExperiment(value, reference, "session-1", "sidecar")).toBe(experiment)
  })
  test("missing, malformed, and expired approval lifetimes fail closed", () => {
    expect(experimentExpired(experiment, 1999)).toBe(false)
    expect(experimentExpired(experiment, 2000)).toBe(true)
    expect(experimentExpired({ ...experiment, expiresAt: undefined }, 1000)).toBe(true)
    expect(experimentExpired({ ...experiment, expiresAt: "invalid" }, 1000)).toBe(true)
  })
})

describe("camera and execution freshness", () => {
  test("unrelated snapshots do not renew a displayed frame lifetime", () => {
    expect(cameraFresh(camera(), 1799)).toBe(true)
    expect(cameraFresh(camera(), 1800)).toBe(false)
    expect(cameraFresh(camera(), 999)).toBe(false)
    expect(cameraFresh({ ...camera(), availability: "unavailable" }, 1200)).toBe(false)
    expect(cameraFresh({ ...camera(), status: { ...camera().status, frameAgeMs: -1 } }, 1200)).toBe(false)
  })
  test("camera identity needs exact candidate, capture, clock and source", () => {
    expect(cameraIdentity(camera())).toBeTruthy()
    expect(cameraIdentity({ ...camera(), status: { ...camera().status, captureSessionId: "other" } })).toBeUndefined()
    expect(
      cameraIdentity({ ...camera(), status: { ...camera().status, selectedCandidateId: "other" } }),
    ).toBeUndefined()
    expect(
      cameraIdentity({
        ...camera(),
        frame: { ...camera().frame!, source: { hardwareIdentity: "", kind: "synthetic", identityStability: "stable" } },
      }),
    ).toBeUndefined()
    expect(
      cameraIdentity({ ...camera(), frame: { ...camera().frame!, capture: { clockSessionId: "other" } } }),
    ).not.toBe(cameraIdentity(camera()))
  })
  test("execution reads expire separately from transport revisions", () => {
    expect(executionFresh({ availability: "available", receivedAt: 1000 }, 5999)).toBe(true)
    expect(executionFresh({ availability: "available", receivedAt: 1000 }, 6000)).toBe(false)
    expect(executionFresh({ availability: "available" }, 1000)).toBe(false)
    expect(executionFresh({ availability: "available", receivedAt: 2000 }, 1000)).toBe(false)
  })
})

test("unconfirmed continuation keeps its persisted request identity across reload", () => {
  const value = snapshot()
  value.experiments!.continuation = {
    status: "UNCONFIRMED",
    requestId: "persisted-request-id",
    experimentId: experiment.id,
    planDigest: experiment.planDigest,
    checkpoint: "trial-checkpoint",
  }
  expect(continuationRequest(value, experiment)).toBe("persisted-request-id")
  expect(continuationRequest(value, { ...experiment, planDigest: "new-plan" })).toBeUndefined()
  value.experiments!.continuation.status = "ACCEPTED"
  expect(continuationRequest(value, experiment)).toBeUndefined()
})
