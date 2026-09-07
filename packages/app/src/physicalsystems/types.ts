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
