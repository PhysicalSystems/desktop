// SPDX-License-Identifier: Apache-2.0
import type {
  PhysicalCommissioning,
  PhysicalCommissioningRecovery,
  PhysicalCommissioningRecoveryClearance,
  PhysicalSnapshot,
} from "./types"

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

export function commissioningRecoveryOwner(snapshot: PhysicalSnapshot | undefined) {
  return snapshot?.activeCommissioning?.find(
    (item) =>
      item.projectId === snapshot.activeProjectId &&
      item.conversationId === snapshot.activeConversationId &&
      item.serverId === snapshot.conversation?.serverId &&
      item.sessionId === snapshot.conversation?.sessionId,
  )
}

export function commissioningRecoveryView(snapshot: PhysicalSnapshot | undefined) {
  return commissioningRecoveryOwner(snapshot)?.recoveryView ?? snapshot?.workcell?.commissioning
}

export function commissioningRecoveryMatches(
  value: PhysicalCommissioning | undefined,
  evidence: PhysicalCommissioningRecovery | PhysicalCommissioningRecoveryClearance | null | undefined,
) {
  const status = value?.recoveryStatus ?? value?.status
  const original = value?.status ?? status
  return Boolean(
    evidence &&
      status?.configuration &&
      original?.configuration &&
      evidence.trialId === status.trial?.trialId &&
      evidence.trialDigest === status.trial.digest &&
      evidence.trialId === original.trial?.trialId &&
      evidence.trialDigest === original.trial.digest &&
      evidence.trialNodeSessionId === (original.trialNodeSessionId ?? original.nodeSessionId) &&
      evidence.trialNodeSessionId === (status.trialNodeSessionId ?? status.nodeSessionId) &&
      ("recoveryDigest" in evidence || evidence.nodeSessionId === status.nodeSessionId) &&
      evidence.configurationDigest === status.configuration.digest &&
      evidence.configurationDigest === original.configuration.digest &&
      evidence.deviceIdentity === status.configuration.deviceIdentity &&
      evidence.deviceIdentity === original.configuration.deviceIdentity,
  )
}

export function commissioningRecoveryResolved(value: PhysicalCommissioning | undefined) {
  const status = value?.recoveryStatus ?? value?.status
  return value?.unresolved === false && commissioningRecoveryMatches(value, status?.recoveryClearance)
}

export function commissioningRecoveryFresh(value: PhysicalCommissioning | undefined, now: number) {
  return Boolean(
    value?.recoveryAvailable &&
      value.recoveryFresh &&
      value.recoveryStatus &&
      typeof value.recoveryReceivedAt === "number" &&
      Number.isFinite(value.recoveryReceivedAt) &&
      Number.isFinite(value.maximumAgeMs) &&
      value.maximumAgeMs > 0 &&
      now >= value.recoveryReceivedAt &&
      now - value.recoveryReceivedAt < Math.min(value.maximumAgeMs, 5000),
  )
}

export function commissioningCanConfirmRecovery(value: PhysicalCommissioning | undefined, now: number) {
  const status = value?.recoveryStatus ?? value?.status
  const recovery = status?.recovery
  return Boolean(
    commissioningRecoveryFresh(value, now) &&
      commissioningRecoveryMatches(value, recovery) &&
      status?.trial?.phase === "OUTCOME_UNKNOWN" &&
      status.canConfirmRecovery &&
      recovery?.ready &&
      Number.isFinite(Date.parse(recovery.expiresAt)) &&
      Date.parse(recovery.expiresAt) > now &&
      !value?.pending &&
      !value?.stopPending &&
      !commissioningRecoveryMatches(value, status.recoveryClearance),
  )
}

export function commissioningRecoveryConsent(snapshot: PhysicalSnapshot | undefined) {
  const view = commissioningRecoveryView(snapshot)
  const status = view?.recoveryStatus ?? view?.status
  if (!snapshot || !status?.recovery || !commissioningRecoveryMatches(view, status.recovery)) return ""
  return JSON.stringify([
    snapshot.serviceId,
    snapshot.activeProjectId,
    snapshot.activeConversationId,
    snapshot.conversation?.serverId,
    snapshot.conversation?.sessionId,
    snapshot.connectionGeneration,
    status.nodeSessionId,
    status.trialNodeSessionId,
    status.configuration?.digest,
    status.configuration?.deviceIdentity,
    status.trial?.trialId,
    status.trial?.digest,
    status.recovery.id,
    status.recovery.digest,
    status.recovery.observedAt,
    status.recovery.expiresAt,
  ])
}
