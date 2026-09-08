// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { candidateNames } from "./artifacts"
import type { CandidateArtifact, CandidatePlatform } from "./artifacts"
import { desktopIdentity } from "./identity"
import { validatePublicBuildInputs } from "./public-build"
import type { PublicBuildInputs } from "./public-build"
import type { PublicCollectionPlan, PublicNativeReceipt } from "./public-collector"
import { publicReviewDigest } from "./public-downloads"
import { publicSmokeCanContinue, PublicProducerError } from "./public-producer"
import { unimplementedPublicChecks, verifyPublicSignaturePair } from "./public-qualification"
import type { QualificationStatus } from "./qualification"

const invalid = () => new PublicProducerError("PUBLIC_NATIVE_RECEIPT_BINDING_INVALID")
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
export const publicNativeProbeIds = [
  "native-v2-credential-probe",
  "native-upgrade-probe",
  "native-failed-upgrade-recovery-probe",
  "native-provider-browser-probe",
  "native-platform-display-probe",
  "native-fresh-appimage-probe",
] as const

export type PublicNativeJobReceipt = Omit<PublicCollectionPlan, "kind"> & {
  kind: "public-desktop-native-job"
  platform: CandidatePlatform
}

export function publicReceiptBytes(value: unknown) {
  const bytes = JSON.stringify(value, null, 2) + "\n"
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
}

/** This is called by the reviewed native smoke controller, never by a manual
 * PASS-file importer. Each fixed probe is authored in process after its actual
 * observations complete; absent probes remain untested. */
export function publicNativeReceipt(input: {
  report: unknown
  artifact: CandidateArtifact
  build: PublicBuildInputs
  publicBuildInputsSha256: string
  runId: string
  runAttempt: number
}): PublicNativeReceipt {
  validatePublicBuildInputs(input.build, input.publicBuildInputsSha256)
  validateRun(input.runId, input.runAttempt)
  // Validates exact artifact/source/input bindings, unique IDs and fixed statuses.
  publicSmokeCanContinue(input)
  const report = input.report as {
    schemaVersion: number
    version: string
    platform: CandidatePlatform
    identity: unknown
    compiledIdentity?: { identity: string; publicBuildInputsSha256: string; mainSha256: string }
    checks: { id: string; status: QualificationStatus }[]
    signing?: {
      status: string
      policy: unknown
      installer: { status: string; publisher: string; certificateThumbprint: string; sha256: string }
      executable: { status: string; publisher: string; certificateThumbprint: string; sha256: string }
    }
    payload?: { executableSha256: string }
  }
  const windows = input.artifact.format === "nsis"
  const platform = windows ? "windows-x64" : "linux-x64"
  if (
    report.schemaVersion !== 1 ||
    report.version !== input.build.version ||
    report.platform !== platform ||
    publicReviewDigest(report.identity) !== publicReviewDigest(desktopIdentity("public")) ||
    report.compiledIdentity?.identity !== "public" ||
    report.compiledIdentity.publicBuildInputsSha256 !== input.publicBuildInputsSha256 ||
    !hash(report.compiledIdentity.mainSha256) ||
    !candidateNames(input.build.version, platform).some(
      (item) => item.name === input.artifact.name && item.format === input.artifact.format,
    )
  )
    throw invalid()
  if (windows) {
    const signing = report.signing
    if (
      !signing ||
      signing.status !== "PASS" ||
      signing.installer?.status !== "PASS" ||
      signing.executable?.status !== "PASS" ||
      signing.installer.sha256 !== input.artifact.sha256 ||
      signing.executable.sha256 !== report.payload?.executableSha256 ||
      publicReviewDigest(signing.policy) !== publicReviewDigest(input.build.windowsSigning)
    )
      throw invalid()
    verifyPublicSignaturePair({
      installer: {
        Status: "Valid",
        Publisher: signing.installer.publisher,
        Thumbprint: signing.installer.certificateThumbprint,
      },
      executable: {
        Status: "Valid",
        Publisher: signing.executable.publisher,
        Thumbprint: signing.executable.certificateThumbprint,
      },
      installerSha256: input.artifact.sha256,
      executableSha256: signing.executable.sha256,
      mode: {
        build: input.build,
        publicBuildInputsSha256: input.publicBuildInputsSha256,
        releaseInputsSha256: input.build.releaseInputsSha256,
      },
    })
  }
  const checks = new Map(report.checks.map((check) => [check.id, check.status]))
  const status = (ids: readonly string[]): QualificationStatus => {
    const values = ids.map((id) => checks.get(id) ?? "NOT_TESTED")
    if (values.includes("FAIL")) return "FAIL"
    if (values.includes("BLOCKED")) return "BLOCKED"
    return values.every((value) => value === "PASS") ? "PASS" : "NOT_TESTED"
  }
  const cleanup = [
    "cleanup",
    ...(windows ? ["public-signing"] : ["native-secret-service-cleanup", "linux-temporary-cleanup"]),
  ]
  const installed = input.artifact.format !== "AppImage"
  const observed: Record<(typeof unimplementedPublicChecks)[number], QualificationStatus> = {
    "native-credential-storage": status(["native-v2-credential-probe", ...cleanup]),
    "provider-browser-sign-in": status(["native-provider-browser-probe", ...cleanup]),
    "fresh-install": status(
      installed
        ? [
            "package-format",
            "launch",
            "device-isolation",
            "uninstall",
            ...cleanup,
            ...(windows ? [] : ["linux-sandbox-setup", "linux-renderer-sandbox"]),
          ]
        : ["native-fresh-appimage-probe", ...cleanup],
    ),
    upgrade: status(["native-upgrade-probe", ...cleanup]),
    "failed-upgrade-recovery": status(["native-failed-upgrade-recovery-probe", ...cleanup]),
    "uninstall-reinstall": status([
      "native-reinstall-probe",
      installed ? "uninstall" : "linux-sandbox-cleanup",
      ...cleanup,
    ]),
    "configuration-preservation": status([
      "native-reinstall-probe",
      installed ? "uninstall" : "linux-sandbox-cleanup",
      ...cleanup,
    ]),
    "platform-display": status(["native-platform-display-probe", ...cleanup]),
  }
  return {
    schemaVersion: 1,
    kind: "public-desktop-native-qualification",
    runId: input.runId,
    runAttempt: input.runAttempt,
    sourceRevision: input.build.sourceRevision,
    releaseInputsSha256: input.build.releaseInputsSha256,
    publicBuildInputsSha256: input.publicBuildInputsSha256,
    artifact: { name: input.artifact.name, bytes: input.artifact.bytes, sha256: input.artifact.sha256 },
    identity: desktopIdentity("public"),
    platform,
    checks: unimplementedPublicChecks.map((id) => ({ id, status: observed[id] })),
  }
}

export function publicNativeJobReceipt(input: {
  env: NodeJS.ProcessEnv
  build: PublicBuildInputs
  publicBuildInputsSha256: string
  platform: CandidatePlatform
  artifacts: PublicNativeJobReceipt["artifacts"]
}): PublicNativeJobReceipt {
  requirePublicNativeContext(input)
  const runId = input.env.GITHUB_RUN_ID || ""
  const runAttempt = Number(input.env.GITHUB_RUN_ATTEMPT)
  const receipt: PublicNativeJobReceipt = {
    schemaVersion: 1,
    kind: "public-desktop-native-job",
    runId,
    runAttempt,
    sourceRevision: input.build.sourceRevision,
    releaseInputsSha256: input.build.releaseInputsSha256,
    publicBuildInputsSha256: input.publicBuildInputsSha256,
    platform: input.platform,
    artifacts: structuredClone(input.artifacts),
  }
  validatePublicNativeJob(receipt, { ...input, runId, runAttempt })
  return receipt
}

export function requirePublicNativeContext(input: {
  env: NodeJS.ProcessEnv
  build: PublicBuildInputs
  publicBuildInputsSha256: string
  platform: CandidatePlatform
}) {
  validatePublicBuildInputs(input.build, input.publicBuildInputsSha256)
  validateRun(input.env.GITHUB_RUN_ID || "", Number(input.env.GITHUB_RUN_ATTEMPT))
  if (
    input.env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
    input.env.GITHUB_REF !== "refs/heads/main" ||
    input.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    input.env.GITHUB_SHA !== input.build.sourceRevision ||
    input.env.CI !== "true" ||
    input.env.GITHUB_ACTIONS !== "true" ||
    input.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    input.env.RUNNER_OS !== (input.platform === "windows-x64" ? "Windows" : "Linux")
  )
    throw invalid()
}

export function validatePublicNativeJob(
  value: unknown,
  expected: {
    build: PublicBuildInputs
    publicBuildInputsSha256: string
    platform: CandidatePlatform
    runId: string
    runAttempt: number
  },
) {
  const receipt = value as PublicNativeJobReceipt
  validateRun(expected.runId, expected.runAttempt)
  const fixed = {
    schemaVersion: 1,
    kind: "public-desktop-native-job",
    runId: expected.runId,
    runAttempt: expected.runAttempt,
    sourceRevision: expected.build.sourceRevision,
    releaseInputsSha256: expected.build.releaseInputsSha256,
    publicBuildInputsSha256: expected.publicBuildInputsSha256,
    platform: expected.platform,
  }
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.keys(receipt).sort().join(",") !== [...Object.keys(fixed), "artifacts"].sort().join(",") ||
    Object.entries(fixed).some(([key, value]) => receipt[key as keyof PublicNativeJobReceipt] !== value) ||
    !Array.isArray(receipt.artifacts)
  )
    throw invalid()
  const names = candidateNames(expected.build.version, expected.platform).map((item) => item.name)
  if (
    receipt.artifacts.length !== names.length ||
    new Set(receipt.artifacts.map((item) => item.name)).size !== names.length ||
    receipt.artifacts.some(
      (item) =>
        !item ||
        Object.keys(item).sort().join(",") !== "bytes,name,nativeSha256,sha256,smokeSha256" ||
        !names.includes(item.name) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 1 ||
        item.bytes > 2 * 1024 ** 3 ||
        !hash(item.sha256) ||
        !hash(item.smokeSha256) ||
        !hash(item.nativeSha256),
    )
  )
    throw invalid()
  return structuredClone(receipt)
}

function validateRun(runId: string, runAttempt: number) {
  if (!/^[1-9]\d*$/.test(runId) || !Number.isSafeInteger(runAttempt) || runAttempt < 1) throw invalid()
}
