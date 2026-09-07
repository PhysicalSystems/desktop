// SPDX-License-Identifier: Apache-2.0
import { win32 } from "node:path"
import { requireDisposablePublicRunner } from "./public-qualification"
import { sha256File } from "./qualification"

export type ReinstallObservation = {
  projectId: string
  sessionId: string
  experimentId: string
  phase: "COMPLETED"
  trialCount: 3
  trialsSha256: string
  transcriptSha256: string
  pinchZoomEnabled: boolean
}

const invalid = () => new Error("PACKAGED_REINSTALL_STATE_CHANGED")
function validateObservation(value: ReinstallObservation) {
  if (
    !value ||
    [value.projectId, value.sessionId, value.experimentId].some(
      (id) => typeof id !== "string" || !id || id.length > 256,
    ) ||
    value.phase !== "COMPLETED" ||
    value.trialCount !== 3 ||
    [value.trialsSha256, value.transcriptSha256].some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
    typeof value.pinchZoomEnabled !== "boolean"
  )
    throw invalid()
}

/** NSIS documents _?= as the final, unquoted argument: it prevents the
 * uninstaller's temporary-copy child, so waiting observes the real uninstall.
 * The caller executes an exact owned copy outside the installation directory. */
function nsisDirectory(installation: string) {
  if (
    !/^[A-Za-z]:\\/.test(installation) ||
    /["\r\n\0]/.test(installation) ||
    win32.normalize(installation) !== installation
  )
    throw new Error("PACKAGED_REINSTALL_PATH_INVALID")
}

export function nsisUninstallArguments(installation: string) {
  nsisDirectory(installation)
  return { args: ["/S", `_?=${installation}`], windowsVerbatimArguments: true as const }
}

/** /D= uses the same final unquoted NSIS command-line convention. */
export function nsisInstallArguments(installation: string) {
  nsisDirectory(installation)
  return { args: ["/S", `/D=${installation}`], windowsVerbatimArguments: true as const }
}

/** Verbatim mode also disables argv0 quoting in Node/Bun. Quote the validated
 * program token explicitly; keep the actual spawn file separate and unquoted. */
export function nsisSpawnOptions(executable: string) {
  nsisDirectory(executable)
  if (!executable.toLowerCase().endsWith(".exe")) throw new Error("PACKAGED_REINSTALL_PATH_INVALID")
  return { argv0: `"${executable}"`, windowsVerbatimArguments: true as const }
}

/** One same-version reinstall, never an upgrade or a public qualification claim.
 * Callbacks own the existing bounded native commands and real relaunch/cleanup.
 * A failed boundary is never retried or followed by the next mutation. */
export async function qualifyInstalledReinstall(
  input: {
    env: NodeJS.ProcessEnv
    root: string
    format: "nsis" | "deb"
    artifact: string
    artifactSha256: string
    payloadSha256: string
    before: ReinstallObservation
    installationState: { unconfirmed: boolean }
    shutdown: { applicationExited: boolean; descendantsExited: boolean }
    uninstall(): Promise<void>
    verifyRemoved(): Promise<void>
    install(): Promise<void>
    installedPayloadSha256(): Promise<string>
    relaunch(): Promise<{ observation: ReinstallObservation; applicationExited: boolean; descendantsExited: boolean }>
  },
  platform: NodeJS.Platform = process.platform,
) {
  // Freeze the evidence before calling any asynchronous lifecycle callback.
  const before = Object.freeze({ ...input.before })
  const { artifact, artifactSha256, payloadSha256, installationState } = input
  await requireDisposablePublicRunner(input.env, input.root, platform)
  if (input.format === "nsis" ? platform !== "win32" : input.format === "deb" ? platform !== "linux" : true)
    throw new Error("PACKAGED_REINSTALL_FORMAT_INVALID")
  if (input.shutdown.applicationExited !== true || input.shutdown.descendantsExited !== true)
    throw new Error("PACKAGED_REINSTALL_SHUTDOWN_UNCONFIRMED")
  if (installationState.unconfirmed !== false) throw new Error("PACKAGED_REINSTALL_SHUTDOWN_UNCONFIRMED")
  validateObservation(before)
  if (!/^[a-f0-9]{64}$/.test(payloadSha256)) throw new Error("PACKAGED_REINSTALL_PAYLOAD_CHANGED")
  if ((await sha256File(artifact)) !== artifactSha256) throw new Error("QUALIFICATION_ARTIFACT_CHANGED")
  installationState.unconfirmed = true
  await input.uninstall()
  await input.verifyRemoved()
  installationState.unconfirmed = false
  if ((await sha256File(artifact)) !== artifactSha256) throw new Error("QUALIFICATION_ARTIFACT_CHANGED")
  installationState.unconfirmed = true
  await input.install()
  if ((await input.installedPayloadSha256()) !== payloadSha256) throw new Error("PACKAGED_REINSTALL_PAYLOAD_CHANGED")
  installationState.unconfirmed = false
  const after = await input.relaunch()
  if (after.applicationExited !== true || after.descendantsExited !== true)
    throw new Error("PACKAGED_REINSTALL_SHUTDOWN_UNCONFIRMED")
  validateObservation(after.observation)
  if ((Object.keys(before) as (keyof ReinstallObservation)[]).some((key) => before[key] !== after.observation[key]))
    throw invalid()
  return {
    sameInstallerBytes: true,
    sameExecutableAndResourcesFingerprint: true,
    preservedConversation: true,
    preservedCompletedExperiment: true,
    preservedTranscript: true,
    preservedPinchZoomPreference: true,
    confirmedRelaunchShutdown: true,
    upgradeTested: false,
    defaultProfileTested: false,
  }
}
