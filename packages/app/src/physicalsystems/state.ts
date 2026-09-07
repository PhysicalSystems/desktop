// SPDX-License-Identifier: Apache-2.0
import type { PhysicalExperiment, PhysicalSnapshot, PhysicalToolReference } from "./types"

/** A delayed reply must never roll back newer owner or approval information. */
export function acceptsSnapshot(previous: PhysicalSnapshot | undefined, next: PhysicalSnapshot) {
  if (!next || !Number.isSafeInteger(next.revision) || !next.serviceId || !Array.isArray(next.projects)) return false
  if (!previous) return true
  return previous.serviceId === next.serviceId && next.revision >= previous.revision
}

export function experimentExpired(record: PhysicalExperiment, now: number) {
  const expiry = typeof record.expiresAt === "number" ? record.expiresAt : Date.parse(record.expiresAt ?? "")
  return !Number.isFinite(expiry) || expiry <= now
}

export function trustedExperiment(
  snapshot: PhysicalSnapshot | undefined,
  reference: unknown,
  sessionId?: string,
  serverId?: string,
) {
  if (!snapshot || !reference || typeof reference !== "object") return
  const value = reference as Partial<PhysicalToolReference>
  if (!sessionId || !serverId || value.sessionId !== sessionId || value.serverId !== serverId) return
  const project = snapshot.projects.find((item) => item.id === value.projectId)
  const conversation = project?.conversations.find(
    (item) => item.id === value.conversationId && item.sessionId === sessionId && item.serverId === serverId,
  )
  if (!conversation || !value.experimentId || !value.planDigest) return
  const current =
    snapshot.activeProjectId === project?.id && snapshot.activeConversationId === conversation.id
      ? snapshot.experiments?.current
      : undefined
  const owned = snapshot.activeExperiments.find(
    (item) =>
      item.projectId === project?.id &&
      item.conversationId === conversation.id &&
      item.sessionId === sessionId &&
      item.serverId === serverId,
  )?.experiment
  const history =
    snapshot.activeProjectId === project?.id && snapshot.activeConversationId === conversation.id
      ? snapshot.experiments?.history
      : []
  return [current, owned, ...(history ?? [])].find((record): record is PhysicalExperiment =>
    Boolean(record && record.id === value.experimentId && record.planDigest === value.planDigest),
  )
}

export function cameraFresh(camera: NonNullable<PhysicalSnapshot["workcell"]>["camera"], now: number) {
  const received = typeof camera?.receivedAt === "number" ? camera.receivedAt : Date.parse(camera?.receivedAt ?? "")
  const age = camera?.status?.frameAgeMs
  const limit = camera?.status?.staleAfterMs
  return Boolean(
    camera?.availability === "available" &&
      camera.frame &&
      camera.previewFrameId &&
      camera.status?.phase === "live" &&
      camera.status.frameFresh === true &&
      Number.isFinite(received) &&
      now >= received &&
      typeof age === "number" &&
      age >= 0 &&
      typeof limit === "number" &&
      limit > 0 &&
      now - received + age < limit,
  )
}

export function cameraIdentity(camera: NonNullable<PhysicalSnapshot["workcell"]>["camera"]) {
  const frame = camera?.frame
  if (
    !frame?.candidateId ||
    !frame.candidateDigest ||
    !frame.captureSessionId ||
    !frame.capture?.clockSessionId ||
    !frame.source?.hardwareIdentity ||
    !frame.source.kind ||
    !frame.source.identityStability ||
    frame.candidateId !== camera?.status?.selectedCandidateId ||
    frame.captureSessionId !== camera.status.captureSessionId
  )
    return
  return JSON.stringify([
    frame.candidateId,
    frame.candidateDigest,
    frame.captureSessionId,
    frame.capture.clockSessionId,
    frame.source.hardwareIdentity,
    frame.source.kind,
    frame.source.identityStability,
  ])
}

export function executionFresh(execution: NonNullable<PhysicalSnapshot["workcell"]>["execution"], now: number) {
  const received =
    typeof execution?.receivedAt === "number" ? execution.receivedAt : Date.parse(execution?.receivedAt ?? "")
  return Boolean(
    execution?.availability === "available" && Number.isFinite(received) && now >= received && now - received < 5000,
  )
}

export function physicalTimestamp(value: string | number | null | undefined, locale: string) {
  if (value === null || value === undefined) return
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return
  return date.toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" })
}

export function continuationRequest(snapshot: PhysicalSnapshot | undefined, record: PhysicalExperiment) {
  const request = snapshot?.experiments?.continuation
  if (
    !request ||
    !["PENDING", "UNCONFIRMED"].includes(request.status) ||
    request.experimentId !== record.id ||
    request.planDigest !== record.planDigest
  )
    return
  return request.requestId
}
