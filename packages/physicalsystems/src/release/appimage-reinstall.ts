// SPDX-License-Identifier: Apache-2.0
import { lstat, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { ReinstallObservation } from "./installed-reinstall"
import { requireDisposableLinuxRunner } from "./linux-qualification"
import { executableArtifactCopy, sha256File } from "./qualification"

function observation(value: ReinstallObservation) {
  const keys = [
    "projectId",
    "sessionId",
    "experimentId",
    "phase",
    "trialCount",
    "trialsSha256",
    "transcriptSha256",
    "pinchZoomEnabled",
  ] as const
  if (
    !value ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value)) ||
    [value.projectId, value.sessionId, value.experimentId].some(
      (id) => typeof id !== "string" || !id || id.length > 256,
    ) ||
    value.phase !== "COMPLETED" ||
    value.trialCount !== 3 ||
    typeof value.pinchZoomEnabled !== "boolean" ||
    [value.trialsSha256, value.transcriptSha256].some((hash) => !/^[a-f0-9]{64}$/.test(hash))
  )
    throw new Error("APPIMAGE_REINSTALL_STATE_CHANGED")
  return JSON.stringify(keys.map((key) => value[key]))
}

/** Portable replacement means deleting only the owned AppImage file and copying
 * the same anchored artifact back. No package registration or maintainer script
 * exists. Native relaunch/ownership/sandbox and profile evidence remain required. */
export async function qualifyAppImageReinstall(input: {
  env: NodeJS.ProcessEnv
  root: string
  artifact: string
  artifactSha256: string
  runnable: string
  before: ReinstallObservation
  replacementState: { unconfirmed: boolean }
  shutdown: { applicationExited: boolean; descendantsExited: boolean; runtimeCacheRemoved: boolean }
  relaunch(): Promise<{
    observation: ReinstallObservation
    applicationExited: boolean
    descendantsExited: boolean
    runtimeCacheRemoved: boolean
  }>
}) {
  const before = observation({ ...input.before })
  const { artifact, artifactSha256, runnable, replacementState } = input
  await requireDisposableLinuxRunner(input.env, input.root)
  if (
    input.shutdown.applicationExited !== true ||
    input.shutdown.descendantsExited !== true ||
    input.shutdown.runtimeCacheRemoved !== true ||
    replacementState.unconfirmed !== false
  )
    throw new Error("APPIMAGE_REINSTALL_SHUTDOWN_UNCONFIRMED")
  if (runnable !== join(input.root, "extractable.AppImage") || artifact === runnable)
    throw new Error("APPIMAGE_RUNTIME_PATH_INVALID")
  if (
    !/^[a-f0-9]{64}$/.test(artifactSha256) ||
    (await sha256File(artifact)) !== artifactSha256 ||
    (await sha256File(runnable)) !== artifactSha256
  )
    throw new Error("APPIMAGE_RUNTIME_ARTIFACT_CHANGED")
  const beforeFile = await lstat(runnable)
  if (
    !beforeFile.isFile() ||
    beforeFile.isSymbolicLink() ||
    beforeFile.nlink !== 1 ||
    beforeFile.uid !== process.getuid?.()
  )
    throw new Error("APPIMAGE_RUNTIME_PATH_INVALID")
  replacementState.unconfirmed = true
  await unlink(runnable)
  await executableArtifactCopy(artifact, runnable, artifactSha256)
  if ((await sha256File(runnable)) !== artifactSha256) throw new Error("APPIMAGE_RUNTIME_ARTIFACT_CHANGED")
  replacementState.unconfirmed = false
  const after = await input.relaunch()
  if (after.applicationExited !== true || after.descendantsExited !== true || after.runtimeCacheRemoved !== true)
    throw new Error("APPIMAGE_REINSTALL_SHUTDOWN_UNCONFIRMED")
  if (observation(after.observation) !== before) throw new Error("APPIMAGE_REINSTALL_STATE_CHANGED")
  return {
    scope: "portable-file-replacement",
    sameArtifactBytes: true,
    originalRuntimeRelaunched: true,
    preservedConversation: true,
    preservedCompletedExperiment: true,
    preservedTranscript: true,
    preservedPinchZoomPreference: true,
    confirmedRelaunchShutdown: true,
    packageRegistrationTested: false,
    upgradeTested: false,
    defaultProfileTested: false,
  }
}
