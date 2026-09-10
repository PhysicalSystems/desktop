// SPDX-License-Identifier: Apache-2.0
import type { PhysicalCommissioning, PhysicalSnapshot } from "./types"

export function commissioningFresh(value: PhysicalCommissioning | undefined, now: number) {
  return Boolean(
    value?.available &&
      value.fresh &&
      value.status &&
      typeof value.receivedAt === "number" &&
      Number.isFinite(value.receivedAt) &&
      Number.isFinite(value.maximumAgeMs) &&
      value.maximumAgeMs > 0 &&
      now >= value.receivedAt &&
      now - value.receivedAt < Math.min(value.maximumAgeMs, 5000),
  )
}

export function commissioningTarget(value: PhysicalCommissioning | undefined, input: string, now: number) {
  const configuration = value?.status?.configuration
  const inspection = value?.status?.inspection
  const target = input.trim() === "" ? NaN : Number(input)
  if (
    !commissioningFresh(value, now) ||
    !value?.status?.canPrepare ||
    value.pending ||
    value.stopPending ||
    !configuration ||
    !inspection?.ready ||
    Date.parse(inspection.expiresAt) <= now ||
    !Number.isFinite(Date.parse(inspection.expiresAt)) ||
    typeof inspection.gripperPosition !== "number" ||
    !Number.isFinite(inspection.gripperPosition) ||
    !Number.isFinite(target) ||
    target < configuration.minimum ||
    target > configuration.maximum ||
    Math.abs(target - inspection.gripperPosition) <= configuration.tolerance ||
    Math.abs(target - inspection.gripperPosition) > configuration.maximumDelta
  )
    return
  const steps = Math.ceil(Math.abs(target - inspection.gripperPosition) / configuration.maximumStep)
  if (steps > 256 || steps * configuration.stepIntervalSeconds >= configuration.maximumDurationSeconds) return
  return target
}

export function commissioningCanApprove(value: PhysicalCommissioning | undefined, now: number) {
  const trial = value?.status?.trial
  return Boolean(
    commissioningFresh(value, now) &&
      value?.status?.canApprove &&
      !value.pending &&
      !value.stopPending &&
      trial?.phase === "WAITING_FOR_APPROVAL" &&
      trial.stopStatus === null &&
      Date.parse(trial.approvalExpiresAt) > now,
  )
}

export function commissioningConsent(snapshot: PhysicalSnapshot | undefined) {
  const status = snapshot?.workcell?.commissioning?.status
  if (!snapshot || !status?.trial || !status.configuration) return ""
  return JSON.stringify([
    snapshot.serviceId,
    snapshot.activeProjectId,
    snapshot.activeConversationId,
    snapshot.conversation?.serverId,
    snapshot.conversation?.sessionId,
    snapshot.connectionGeneration,
    status.nodeSessionId,
    status.configuration.digest,
    status.inspection?.digest,
    status.trial.trialId,
    status.trial.digest,
  ])
}
