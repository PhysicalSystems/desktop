// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import type { ReleaseInputs } from "./inputs"
import { requiredQualificationChecks } from "./qualification"

export type CandidatePlatform = "windows-x64" | "linux-x64"
export type CandidateArtifact = {
  name: string
  format: "nsis" | "deb" | "AppImage"
  bytes: number
  sha256: string
  sha512: string
}
export type CandidateInventory = {
  schemaVersion: 1
  inputsSha256: string
  sourceRevision: string
  version: string
  platform: CandidatePlatform
  publication: false
  files: CandidateArtifact[]
}
export type Qualification = {
  schemaVersion: 1
  artifact: { name: string; sha256: string; bytes: number }
  version: string
  platform: CandidatePlatform
  simulationOnly: true
  opticalFlickerMeasured: false
  checks: { id: string; status: "PASS" | "FAIL" | "NOT_TESTED" | "BLOCKED"; detail?: string }[]
  result: "PASS" | "FAIL" | "NOT_TESTED" | "BLOCKED"
  inputsSha256?: string
  sourceRevision?: string
  deviceConnectionsAllowed: false
  payload?: { sha256: string; executableSha256: string }
  signature: { status: "PASS" | "FAIL" | "NOT_TESTED" | "BLOCKED"; trust: string; signerThumbprint?: string }
  publicDistribution: { status: "BLOCKED"; reason: string }
}
type CandidateInputs = Pick<ReleaseInputs, "version" | "channel" | "sha256" | "source">
export type PlatformReport = {
  schemaVersion: 1
  inputsSha256: string
  inventory: CandidateInventory
  qualifications: Qualification[]
  checks: { artifact: string; status: "PASS" | "FAIL"; reason?: string }[]
  result: "PASS" | "FAIL"
  publication: false
}

export function candidateNames(version: string, platform: CandidatePlatform) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/.test(version))
    throw new Error("Invalid candidate version")
  if (platform === "windows-x64")
    return [{ name: `physical-systems-desktop-${version}-windows-x64.exe`, format: "nsis" as const }]
  if (platform !== "linux-x64") throw new Error("Unsupported candidate platform")
  return [
    { name: `physical-systems-desktop-${version}-linux-x64.deb`, format: "deb" as const },
    { name: `physical-systems-desktop-${version}-linux-x64.AppImage`, format: "AppImage" as const },
  ]
}

export async function artifactDigest(file: string) {
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.size === 0)
    throw new Error("Expected a nonempty regular artifact")
  const sha256 = createHash("sha256")
  const sha512 = createHash("sha512")
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk)
    sha512.update(chunk)
  }
  const after = await lstat(file)
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error("Artifact changed during verification")
  return { bytes: after.size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") }
}

export async function createInventory(
  folder: string,
  inputs: CandidateInputs,
  platform: CandidatePlatform,
): Promise<CandidateInventory> {
  const names = candidateNames(inputs.version, platform)
  const entries = await readdir(folder)
  if (
    entries.some((entry) => /\.(exe|deb|AppImage)$/i.test(entry) && !names.some((expected) => expected.name === entry))
  )
    throw new Error("Unexpected installer in candidate output")
  const files = await Promise.all(
    names.map(async (entry) => ({ ...entry, ...(await artifactDigest(join(folder, entry.name))) })),
  )
  return {
    schemaVersion: 1,
    inputsSha256: inputs.sha256,
    sourceRevision: inputs.source.revision,
    version: inputs.version,
    platform,
    publication: false,
    files,
  }
}

export async function verifyInventory(folder: string, inputs: CandidateInputs): Promise<CandidateInventory> {
  const file = join(folder, "artifacts.json")
  if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink())
    throw new Error("Invalid artifact inventory")
  const saved = JSON.parse(await readFile(file, "utf8")) as CandidateInventory
  const expected = await createInventory(folder, inputs, saved.platform)
  if (JSON.stringify(saved) !== JSON.stringify(expected))
    throw new Error("Candidate inventory does not match exact inputs and artifact bytes")
  return expected
}

export function verifyQualification(artifact: CandidateArtifact, inventory: CandidateInventory, report: Qualification) {
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.artifact?.name !== artifact.name ||
    report.artifact?.sha256 !== artifact.sha256 ||
    report.artifact?.bytes !== artifact.bytes ||
    report.version !== inventory.version ||
    report.platform !== inventory.platform ||
    report.simulationOnly !== true ||
    report.opticalFlickerMeasured !== false
  )
    throw new Error("Qualification does not identify the exact candidate")
  if (!Array.isArray(report.checks) || new Set(report.checks.map((check) => check.id)).size !== report.checks.length)
    throw new Error("Duplicate or missing qualification checks")
  if (
    report.inputsSha256 !== inventory.inputsSha256 ||
    report.sourceRevision !== inventory.sourceRevision ||
    report.deviceConnectionsAllowed !== false ||
    report.publicDistribution?.status !== "BLOCKED" ||
    !report.payload ||
    !/^[a-f0-9]{64}$/.test(report.payload.sha256) ||
    !/^[a-f0-9]{64}$/.test(report.payload.executableSha256)
  )
    throw new Error("Qualification lacks exact embedded source, payload or candidate scope")
  if (
    !report.signature ||
    report.signature.status === "FAIL" ||
    !["PASS", "BLOCKED", "NOT_TESTED"].includes(report.signature.status)
  )
    throw new Error("Qualification signature verification failed")
  if (
    artifact.format === "nsis" &&
    !(
      (report.signature.status === "PASS" &&
        report.signature.trust === "WINDOWS_AUTHENTICODE_VALID" &&
        /^[a-fA-F0-9]{40,64}$/.test(report.signature.signerThumbprint || "")) ||
      (report.signature.status === "BLOCKED" &&
        ["UNSIGNED_INTERNAL_CANDIDATE", "INSTALLER_VALID_PAYLOAD_UNSIGNED"].includes(report.signature.trust))
    )
  )
    throw new Error("Windows signature inspection is incomplete")
  if (
    report.result !== "PASS" ||
    report.checks.some((check) => !["PASS", "NOT_TESTED"].includes(check.status)) ||
    requiredQualificationChecks.some((id) => report.checks.find((check) => check.id === id)?.status !== "PASS") ||
    (artifact.format === "nsis" && report.checks.find((check) => check.id === "uninstall")?.status !== "PASS")
  )
    throw new Error("Candidate packaged qualification is incomplete")
  return report
}

export function candidateDownloads(inputs: CandidateInputs, inventories: CandidateInventory[]) {
  if (!inventories.length || new Set(inventories.map((inventory) => inventory.platform)).size !== inventories.length)
    throw new Error("Duplicate or empty platform inventory")
  for (const inventory of inventories) {
    if (
      inventory.schemaVersion !== 1 ||
      inventory.inputsSha256 !== inputs.sha256 ||
      inventory.sourceRevision !== inputs.source.revision ||
      inventory.version !== inputs.version ||
      inventory.publication !== false
    )
      throw new Error("Mixed release inputs in download inventory")
    const expected = candidateNames(inputs.version, inventory.platform)
    if (
      !Array.isArray(inventory.files) ||
      inventory.files.length !== expected.length ||
      new Set(inventory.files.map((file) => file.name)).size !== expected.length ||
      inventory.files.some(
        (file) =>
          basename(file.name) !== file.name ||
          !expected.some((item) => item.name === file.name && item.format === file.format) ||
          !Number.isSafeInteger(file.bytes) ||
          file.bytes <= 0 ||
          !/^[a-f0-9]{64}$/.test(file.sha256) ||
          !/^[a-zA-Z0-9+/]{86}==$/.test(file.sha512),
      )
    )
      throw new Error("Unexpected candidate download artifact")
  }
  return {
    schemaVersion: 1,
    status: "candidate",
    publication: false,
    version: inputs.version,
    channel: inputs.channel,
    inputsSha256: inputs.sha256,
    releaseNotesUrl: null,
    // A local candidate must never fabricate a live release URL or a public qualification.
    artifacts: inventories.flatMap((inventory) =>
      inventory.files.map((file) => ({ ...file, platform: inventory.platform, url: null })),
    ),
  }
}

/** Recheck embedded per-artifact evidence; a platform's PASS label is insufficient. */
export function verifyPlatformReport(inputs: CandidateInputs, report: PlatformReport) {
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.inputsSha256 !== inputs.sha256 ||
    report.publication !== false ||
    report.result !== "PASS"
  )
    throw new Error("Platform qualification report is incomplete")
  candidateDownloads(inputs, [report.inventory])
  if (
    !Array.isArray(report.qualifications) ||
    report.qualifications.length !== report.inventory.files.length ||
    new Set(report.qualifications.map((item) => item.artifact.name)).size !== report.inventory.files.length ||
    !Array.isArray(report.checks) ||
    report.checks.length !== report.inventory.files.length ||
    new Set(report.checks.map((item) => item.artifact)).size !== report.inventory.files.length
  )
    throw new Error("Platform report requires one exact receipt per artifact")
  for (const artifact of report.inventory.files) {
    const receipt = report.qualifications.find((item) => item.artifact.name === artifact.name)
    if (!receipt || report.checks.find((item) => item.artifact === artifact.name)?.status !== "PASS")
      throw new Error("Platform report is missing artifact evidence")
    verifyQualification(artifact, report.inventory, receipt)
  }
  return report
}

export function checksums(files: CandidateArtifact[]) {
  return files.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n"
}
