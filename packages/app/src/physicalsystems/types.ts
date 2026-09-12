// SPDX-License-Identifier: Apache-2.0
/** Public renderer contract. Credentials and agent tokens never cross this boundary. */
import type { LegacyMigrationBridge } from "../../../physicalsystems/src/migration-types"
export type PhysicalScope = {
  projectId: string
  conversationId: string
  connectionGeneration: number
  serverId?: string
  sessionId?: string
}

export type PhysicalConnection = {
  kind: "simulation" | "local" | "ssh"
  label: string
  status: string
  observedAt: string | number | null
  deviceCount: number | null
  inUseCount: number | null
  error?: string | null
  autoConnect?: boolean
}

export type PhysicalConversation = {
  id: string
  title: string
  serverId?: string
  sessionId?: string
  busy?: boolean
  error?: string | null
}

export type PhysicalProject = {
  id: string
  name: string
  cwd?: string
  connection: PhysicalConnection
  conversations: PhysicalConversation[]
}

export type PhysicalTrial = {
  id?: string
  status?: string
  phase?: string
  offsetMm?: number
  parameters?: { offsetMm?: number }
  result?: { alignmentErrorMm?: number }
  error?: string
}

export type PhysicalExperiment = {
  id: string
  goal: string
  phase: string
  planDigest: string
  trialLimit: number
  expiresAt?: string | number
  trials: PhysicalTrial[]
  reason?: string
  recoveryReason?: string
  summary?: { interpretation?: string }
  error?: { message?: string }
}

export type PhysicalRun = {
  runId: string
  runDigest?: string
  mode?: string
  phase: string
  stopStatus?: string
  configurationId?: string
  approval?: { digest: string; expiresAt: string | number; approvedAt?: string | null }
  inputs?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

export type PhysicalOwner = {
  projectId: string
  projectName?: string
  conversationId?: string
  serverId?: string
  sessionId?: string
  connectionGeneration: number
  statusUnavailable?: boolean
  canStop: boolean
  error?: string
}

export type PhysicalDevice = {
  deviceId: string
  displayName?: string
  kind?: string
  detected?: boolean
  readiness?: string
  driverReady?: boolean
  adapterId?: string
  adapterStatus?: string
}

export type PhysicalSetupFinding = {
  id?: string
  code?: string
  status?: string
  message?: string
  detail?: string
  action?: string
}

export type PhysicalSetup = {
  inspection?: { status?: string; message?: string }
  checks?: PhysicalSetupFinding[]
  requestBlockers?: PhysicalSetupFinding[]
  implementations?: { implementationId?: string; checks?: PhysicalSetupFinding[] }[]
}

export type PhysicalCommissioningRecovery = {
  id: string
  digest: string
  trialId: string
  trialDigest: string
  trialNodeSessionId: string
  nodeSessionId: string
  configurationDigest: string
  deviceIdentity: string
  observedAt: string
  expiresAt: string
  ready: boolean
  positions: Record<string, number | null>
  torqueEnabled: Record<string, boolean | null>
  checks: { code: string; state: "met" | "violated" | "unknown"; message: string }[]
}

export type PhysicalCommissioningRecoveryClearance = {
  id: string
  digest: string
  trialId: string
  trialDigest: string
  trialNodeSessionId: string
  nodeSessionId: string
  configurationDigest: string
  deviceIdentity: string
  recoveryDigest: string
  confirmedAt: string
  inspectionDigest: string
  priorRunDigest: string
  priorRevision: number
}

export type PhysicalCommissioningStatus = {
  contractVersion: "physicalsystems-gripper-check-v1"
  nodeSessionId: string
  configuration: {
    id: string
    digest: string
    displayName: string
    deviceIdentity: string
    calibrationDigest: string
    minimum: number
    maximum: number
    maximumDelta: number
    maximumDurationSeconds: number
    maximumStep: number
    stepIntervalSeconds: number
    tolerance: number
  } | null
  inspection: {
    id: string
    digest: string
    observedAt: string
    expiresAt: string
    ready: boolean
    positions: Record<string, number | null>
    torqueEnabled: Record<string, boolean | null>
    checks: { code: string; state: "met" | "violated" | "unknown"; message: string }[]
    gripperPosition: number | null
  } | null
  trial: {
    trialId: string
    digest: string
    phase: "WAITING_FOR_APPROVAL" | "RUNNING" | "COMPLETED" | "STOPPED" | "FAILED" | "OUTCOME_UNKNOWN"
    approvalExpiresAt: string
    startPosition: number
    targetPosition: number
    maximumDurationSeconds: number
    latestPosition: number | null
    stopStatus: "STOPPING" | "STOPPED" | "STOP_UNCONFIRMED" | null
    message: string | null
  } | null
  canInspect: boolean
  canPrepare: boolean
  canApprove: boolean
  canStop: boolean
  blockedReason: string | null
  trialNodeSessionId?: string | null
  recovery?: PhysicalCommissioningRecovery | null
  recoveryClearance?: PhysicalCommissioningRecoveryClearance | null
  canInspectRecovery?: boolean
  canConfirmRecovery?: boolean
}

export type PhysicalCommissioning = {
  status: PhysicalCommissioningStatus | null
  recoveryStatus?: PhysicalCommissioningStatus | null
  recoveryAvailable?: boolean
  recoveryFresh?: boolean
  recoveryReceivedAt?: number | null
  fresh: boolean
  available: boolean
  receivedAt: number | null
  maximumAgeMs: number
  pending: "refresh" | "inspect" | "prepare" | "approve" | "recoveryInspect" | "recoveryConfirm" | null
  stopPending: boolean
  message: string | null
  unresolved?: boolean
}

export type PhysicalWorkcell = {
  sessionId?: string
  workflow?: {
    routeReceipt?: { receiptDigest: string }
    snapshot?: {
      observedAt?: string | number
      discovery?: { observedAt?: string | number; devices?: PhysicalDevice[] }
    }
  }
  setup?: PhysicalSetup
  commissioning?: PhysicalCommissioning
  camera?: {
    availability?: string
    pending?: string | null
    stopPending?: boolean
    stopUnconfirmed?: boolean
    canStart?: boolean
    stopCaptureSessionId?: string | null
    previewFrameId?: string | null
    receivedAt?: string | number | null
    frame?: {
      frameId?: string
      candidateId: string
      candidateDigest: string
      captureSessionId: string
      capture: { clockSessionId: string; [key: string]: unknown }
      source: { hardwareIdentity: string; kind: string; identityStability: string }
      observation?: unknown
    }
    status?: {
      phase?: string
      captureSessionId?: string
      selectedCandidateId?: string
      frameFresh?: boolean
      frameAgeMs?: number
      staleAfterMs?: number
      availableCameras?: { candidateId: string; candidateDigest: string; displayName?: string }[]
    }
  }
  execution?: {
    availability?: string
    observedAt?: string | number
    receivedAt?: string | number
    pending?: boolean
    stopPending?: boolean
    canPrepare?: boolean
    canApprove?: boolean
    configurations?: {
      configurationId: string
      configurationDigest: string
      displayName?: string
      mode?: string
      inputs?: Record<string, unknown>
    }[]
    run?: PhysicalRun | null
    runs?: PhysicalRun[]
    error?: string
  }
}

export type PhysicalFrame = PhysicalScope & {
  id: string
  contentType: "image/jpeg"
  bytes: number[] | Uint8Array
  captureSessionId: string
}

export type PhysicalSnapshot = {
  revision: number
  serviceId: string
  activeProjectId: string | null
  activeConversationId: string | null
  connectionGeneration: number
  hostUnavailable?: boolean
  closeBlocked?: boolean
  notice?: string
  projects: PhysicalProject[]
  conversation: PhysicalConversation | null
  workcell: PhysicalWorkcell | null
  setupReport: PhysicalSetup | null
  experiments: {
    availability: string
    current: PhysicalExperiment | null
    history?: PhysicalExperiment[]
    error?: string
    historical?: boolean
    continuation?: {
      requestId: string
      status: "PENDING" | "UNCONFIRMED" | "ACCEPTED"
      experimentId: string
      planDigest: string
      checkpoint: string
    } | null
  } | null
  activeRuns: (PhysicalOwner & { run: PhysicalRun })[]
  activeCaptures: (PhysicalOwner & {
    captureSessionId?: string | null
    pending?: boolean
    stopPending?: boolean
    stopUnconfirmed?: boolean
  })[]
  activeExperiments: (PhysicalOwner & { experiment: PhysicalExperiment })[]
  activeCommissioning?: (PhysicalOwner & {
    status: PhysicalCommissioningStatus | null
    recoveryView?: PhysicalCommissioning
    trialId: string | null
    nodeSessionId: string | null
    stopPending: boolean
  })[]
  /** Ephemeral response data, never a model-supplied result or authority. */
  commandResult?: {
    continuation?: { accepted: boolean; duplicate?: boolean; requestId: string; error?: string }
    frame?: PhysicalFrame
  }
}

export type PhysicalCommand =
  | { type: "connection.saveCredential"; projectId: string; cameraToken: string; executionToken?: string }
  | {
      type: "project.create"
      name: string
      cwd?: string
      connection: {
        type: "simulation" | "local" | "ssh"
        label?: string
        nodeUrl?: string
        host?: string
        username?: string
        port?: number
        remotePort?: number
      }
    }
  | { type: "project.select" | "connection.connect" | "connection.disconnect"; projectId: string }
  | { type: "project.rename"; projectId: string; name: string }
  | { type: "session.bind"; projectId: string; serverId: string; sessionId: string; title?: string }
  | { type: "session.select"; projectId: string; conversationId: string }
  | ({
      type: "experiment.approveAndContinue"
      experimentId: string
      expectedDigest: string
      requestId: string
      approved: true
    } & PhysicalScope)
  | ({ type: "experiment.continue"; experimentId: string; expectedDigest: string; requestId: string } & PhysicalScope)
  | ({ type: "experiment.propose"; goal: string; trialLimit: number; requestId: string } & PhysicalScope)
  | ({ type: "experiment.finish" | "experiment.stop"; experimentId: string } & PhysicalScope)
  | ({ type: "workcell.refresh" | "workcell.setup.inspect" | "workcell.execution.refresh" } & PhysicalScope)
  | ({ type: "workcell.commissioning.refresh" | "workcell.commissioning.inspect" } & PhysicalScope)
  | ({
      type: "workcell.commissioning.prepare"
      configurationDigest: string
      inspectionDigest: string
      targetPosition: number
    } & PhysicalScope)
  | ({ type: "workcell.commissioning.approve"; trialId: string; trialDigest: string; approved: true } & PhysicalScope)
  | ({ type: "workcell.commissioning.stop"; trialId: string; reason: "operator-requested-stop" } & PhysicalScope)
  | ({ type: "workcell.commissioning.recoveryInspect"; trialId: string; trialDigest: string } & PhysicalScope)
  | ({
      type: "workcell.commissioning.recoveryConfirm"
      trialId: string
      trialDigest: string
      recoveryDigest: string
      confirmed: true
    } & PhysicalScope)
  | ({ type: "workcell.camera.start"; candidateId: string; expectedCandidateDigest: string } & PhysicalScope)
  | ({ type: "workcell.camera.frame"; frameId: string } & PhysicalScope)
  | {
      type: "workcell.camera.stop"
      projectId: string
      conversationId: string
      serverId?: string
      sessionId?: string
      connectionGeneration: number
      expectedCaptureSessionId: string | null
    }
  | ({
      type: "workcell.execution.prepare"
      configurationId: string
      expectedConfigurationDigest: string
      routeReceiptDigest: string
    } & PhysicalScope)
  | ({
      type: "workcell.execution.approve"
      runId: string
      expectedRunDigest: string
      approvalDigest: string
      approved: true
    } & PhysicalScope)
  | {
      type: "workcell.execution.stop"
      projectId: string
      conversationId: string
      serverId?: string
      sessionId?: string
      connectionGeneration: number
      runId: string
      reason: "operator-requested-stop"
    }
  | ({
      type: "workcell.execution.reconcile" | "workcell.execution.select"
      runId: string
      expectedRunDigest?: string
    } & PhysicalScope)

export type PhysicalSystemsBridge = {
  recover?(): Promise<PhysicalSnapshot>
  migration?: LegacyMigrationBridge
  snapshot(): Promise<PhysicalSnapshot>
  command(request: PhysicalCommand): Promise<PhysicalSnapshot>
  subscribe(listener: (snapshot: PhysicalSnapshot) => void): () => void
}

/** Tool metadata identifies a record; only a matching service snapshot can authorize it. */
export type PhysicalToolReference = {
  projectId: string
  conversationId: string
  serverId: string
  sessionId: string
  experimentId?: string
  planDigest?: string
}
