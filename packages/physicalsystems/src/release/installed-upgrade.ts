// SPDX-License-Identifier: Apache-2.0
import { desktopIdentity } from "./identity"
import { debianPackageVersion } from "./linux-qualification"
import type { ReinstallObservation } from "./installed-reinstall"
import {
  publicAuthenticodeObservation,
  requireDisposablePublicRunner,
  verifyPublicSignaturePair,
} from "./public-qualification"
import { publicReviewDigest } from "./public-downloads"
import { sha256File } from "./qualification"
import { validatePublicUpgradePlan } from "./public-upgrade"
import type { publicUpgradePlan } from "./public-upgrade"

export type UpgradeApplicationObservation = {
  version: string
  executableAndResourcesSha256: string
  vaultSha256: string
  state: ReinstallObservation
}

export type UpgradeInterruption =
  | {
      kind: "debian-unpacked-before-configuration" | "windows-partial-payload-copy"
      installerExited: boolean
      descendantsExited: boolean
      baselinePayloadChanged: boolean
      targetInstallationComplete: boolean
    }
  | {
      kind: "appimage-partial-staging-before-atomic-replacement"
      writerClosed: boolean
      baselinePayloadChanged: false
      targetInstallationComplete: false
      stagedBytes: number
    }

const failure = (code: string) => new Error(`PUBLIC_UPGRADE_${code}`)

/** Qualifies one already seeded older installation. Native callbacks belong to
 * the existing owned controller; helper tests cannot establish a native PASS. */
export async function qualifyInstalledUpgrade(
  input: {
    env: NodeJS.ProcessEnv
    root: string
    format: "nsis" | "deb" | "appimage"
    mode: "upgrade" | "recovery"
    plan: unknown
    expectedPlanSha256: string
    builds: Parameters<typeof publicUpgradePlan>[0]
    signatures?: {
      baseline: ReturnType<typeof verifyPublicSignaturePair>
      target: ReturnType<typeof verifyPublicSignaturePair>
    }
    baselineArtifact: string
    baselineArtifactSha256: string
    targetArtifact: string
    targetArtifactSha256: string
    targetPayloadSha256: string
    before: UpgradeApplicationObservation
    shutdown: { applicationExited: boolean; descendantsExited: boolean }
    installationState: { unconfirmed: boolean }
    observeInstalled(): Promise<{ version: string; executableAndResourcesSha256: string }>
    installTarget(): Promise<void>
    interruptTarget(): Promise<UpgradeInterruption>
    relaunchBaseline?(): Promise<
      UpgradeApplicationObservation & { applicationExited: boolean; descendantsExited: boolean }
    >
    relaunchTarget(): Promise<
      UpgradeApplicationObservation & { applicationExited: boolean; descendantsExited: boolean }
    >
  },
  platform: NodeJS.Platform = process.platform,
) {
  const baseline = structuredClone(input.before)
  const builds = structuredClone(input.builds)
  const signatures = structuredClone(input.signatures)
  const plan = validatePublicUpgradePlan(input.plan, input.expectedPlanSha256, builds)
  const {
    baselineArtifact,
    baselineArtifactSha256,
    targetArtifact,
    targetArtifactSha256,
    targetPayloadSha256,
    installationState,
    mode,
    format,
    expectedPlanSha256,
  } = input
  const shutdown = { ...input.shutdown }
  await requireDisposablePublicRunner(input.env, input.root, platform)
  if (
    !["nsis", "deb", "appimage"].includes(format) ||
    (format === "nsis" ? platform !== "win32" : platform !== "linux") ||
    !["upgrade", "recovery"].includes(mode)
  )
    throw failure("FORMAT_INVALID")
  if (
    shutdown.applicationExited !== true ||
    shutdown.descendantsExited !== true ||
    installationState.unconfirmed !== false
  )
    throw failure("SHUTDOWN_UNCONFIRMED")
  if (format === "nsis") {
    for (const [key, digest] of [
      ["baseline", baselineArtifactSha256],
      ["target", targetArtifactSha256],
    ] as const) {
      const signed = signatures?.[key]
      if (
        !signed ||
        signed.status !== (builds[key].windowsSigning.provider === "unsigned-preview" ? "UNSIGNED_PREVIEW" : "PASS") ||
        signed.installer.sha256 !== digest ||
        publicReviewDigest(signed.policy) !== publicReviewDigest(builds[key].windowsSigning)
      )
        throw failure("SIGNATURE_UNCONFIRMED")
      verifyPublicSignaturePair({
        installer: publicAuthenticodeObservation(signed.installer),
        executable: publicAuthenticodeObservation(signed.executable),
        installerSha256: digest,
        executableSha256: signed.executable.sha256,
        mode: {
          build: builds[key],
          publicBuildInputsSha256: key === "baseline" ? builds.expectedBaselineSha256 : builds.expectedTargetSha256,
          releaseInputsSha256: builds[key].releaseInputsSha256,
        },
      })
    }
  }
  if (
    baseline.version !== plan.baseline.version ||
    baseline.state.phase !== "COMPLETED" ||
    baseline.state.trialCount !== 3 ||
    ![
      baseline.executableAndResourcesSha256,
      baseline.vaultSha256,
      baseline.state.transcriptSha256,
      baseline.state.trialsSha256,
      targetPayloadSha256,
    ].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ||
    baseline.executableAndResourcesSha256 === targetPayloadSha256 ||
    ![baseline.state.projectId, baseline.state.sessionId, baseline.state.experimentId].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
    ) ||
    typeof baseline.state.pinchZoomEnabled !== "boolean"
  )
    throw failure("BASELINE_UNCONFIRMED")
  const verifyArtifacts = async () => {
    if (
      baselineArtifact === targetArtifact ||
      baselineArtifactSha256 === targetArtifactSha256 ||
      (await sha256File(baselineArtifact)) !== baselineArtifactSha256 ||
      (await sha256File(targetArtifact)) !== targetArtifactSha256
    )
      throw failure("ARTIFACT_CHANGED")
  }
  await verifyArtifacts()
  const installed = await input.observeInstalled()
  if (
    installed.version !== baseline.version ||
    installed.executableAndResourcesSha256 !== baseline.executableAndResourcesSha256
  )
    throw failure("BASELINE_UNCONFIRMED")
  await verifyArtifacts()
  const unchanged = (observed: UpgradeApplicationObservation) =>
    observed.vaultSha256 === baseline.vaultSha256 &&
    Object.keys(baseline.state).every(
      (key) => baseline.state[key as keyof ReinstallObservation] === observed.state[key as keyof ReinstallObservation],
    )
  let interruption: UpgradeInterruption | undefined
  if (mode === "recovery") {
    installationState.unconfirmed = true
    interruption = await input.interruptTarget()
    if (
      interruption.kind !==
        (format === "deb"
          ? "debian-unpacked-before-configuration"
          : format === "nsis"
            ? "windows-partial-payload-copy"
            : "appimage-partial-staging-before-atomic-replacement") ||
      (interruption.kind === "appimage-partial-staging-before-atomic-replacement"
        ? interruption.writerClosed !== true ||
          !Number.isSafeInteger(interruption.stagedBytes) ||
          interruption.stagedBytes <= 0
        : interruption.installerExited !== true || interruption.descendantsExited !== true) ||
      interruption.baselinePayloadChanged !== (format !== "appimage") ||
      interruption.targetInstallationComplete !== false
    )
      throw failure("INTERRUPTION_UNCONFIRMED")
    if (format === "appimage") {
      // Atomic replacement leaves the prior artifact runnable. Prove that real
      // baseline still opens the same profile before completing replacement.
      if (!input.relaunchBaseline) throw failure("BASELINE_UNCONFIRMED")
      const restored = await input.relaunchBaseline()
      if (
        !restored.applicationExited ||
        !restored.descendantsExited ||
        restored.version !== baseline.version ||
        restored.executableAndResourcesSha256 !== baseline.executableAndResourcesSha256 ||
        !unchanged(restored)
      )
        throw failure("BASELINE_UNCONFIRMED")
    }
    // This is a verified partial installation/staging with no process mutating it.
    // Only exact-target recovery is authorized next; uncertainty stays set until
    // the installed version/fingerprint is verified after that recovery.
    await verifyArtifacts()
  }
  installationState.unconfirmed = true
  await input.installTarget()
  const target = await input.observeInstalled()
  if (target.version !== plan.target.version || target.executableAndResourcesSha256 !== targetPayloadSha256)
    throw failure("TARGET_UNCONFIRMED")
  installationState.unconfirmed = false
  const after = await input.relaunchTarget()
  if (after.applicationExited !== true || after.descendantsExited !== true) throw failure("SHUTDOWN_UNCONFIRMED")
  if (
    after.version !== plan.target.version ||
    after.executableAndResourcesSha256 !== targetPayloadSha256 ||
    !unchanged(after)
  )
    throw failure("STATE_CHANGED")
  return {
    baselinePurpose: plan.baselinePurpose,
    scope: plan.scope,
    baselineVersion: plan.baseline.version,
    targetVersion: plan.target.version,
    baselineArtifactSha256,
    targetArtifactSha256,
    planSha256: expectedPlanSha256,
    sameInstallerBytes: true,
    targetExecutableAndResourcesMatch: true,
    preservedConversation: true,
    preservedCompletedExperiment: true,
    preservedTranscript: true,
    preservedPinchZoomPreference: true,
    preservedEncryptedVault: true,
    confirmedRelaunchShutdown: true,
    historicalDatabaseMigrationTested: false,
    powerLossTested: false,
    ...(interruption ? { interruption: interruption.kind } : {}),
  }
}

/** dpkg --unpack is a real replacement phase. The controlled stop before
 * --configure must be observed in the exact package's native status database. */
export function requireDebianUpgradeStatus(status: string, version: string, state: "unpacked" | "installed") {
  const records = status
    .split(/\r?\n\r?\n/)
    .filter((record) => record.split(/\r?\n/).includes(`Package: ${desktopIdentity("public").packageName}`))
  if (records.length !== 1) throw failure("DEBIAN_STATE_UNCONFIRMED")
  const values = records[0]!.split(/\r?\n/)
  if (
    values.filter((line) => line.startsWith("Package:")).length !== 1 ||
    values.filter((line) => line.startsWith("Version:")).length !== 1 ||
    values.filter((line) => line.startsWith("Status:")).length !== 1 ||
    !values.includes(`Version: ${debianPackageVersion(version)}`) ||
    !values.includes(`Status: install ok ${state}`)
  )
    throw failure("DEBIAN_STATE_UNCONFIRMED")
}
