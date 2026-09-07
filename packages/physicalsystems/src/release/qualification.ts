// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import { chmod, copyFile, lstat, readdir } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"

export type QualificationStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_TESTED"
export type QualificationCheck = { id: string; status: QualificationStatus; detail: string }
export type SignatureResult = { status: QualificationStatus; trust: string; signerThumbprint?: string }
export const requiredQualificationChecks = [
  "artifact-integrity",
  "package-format",
  "payload-integrity",
  "bundled-runtime",
  "desktop-version",
  "launch",
  "device-isolation",
  "synthetic-chat",
  "inline-approval",
  "reload",
  "cleanup",
]

/** An .exe extension, certificate presence, or command exit status is not trust. */
export function authenticodeResult(input: unknown): SignatureResult {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { status: "FAIL", trust: "INVALID_SIGNATURE_RESULT" }
  const value = input as Record<string, unknown>
  if (value.Status === "NotSigned") return { status: "BLOCKED", trust: "UNSIGNED_INTERNAL_CANDIDATE" }
  if (value.Status !== "Valid") return { status: "FAIL", trust: "SIGNATURE_NOT_VALID" }
  if (typeof value.Thumbprint !== "string" || !/^[a-fA-F0-9]{40,64}$/.test(value.Thumbprint))
    return { status: "FAIL", trust: "SIGNER_IDENTITY_MISSING" }
  return { status: "PASS", trust: "WINDOWS_AUTHENTICODE_VALID", signerThumbprint: value.Thumbprint.toUpperCase() }
}

export async function sha256File(file: string) {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("QUALIFICATION_REGULAR_FILE_REQUIRED")
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

/** Download artifacts may lose mode bits. Never chmod the immutable input itself. */
export async function executableArtifactCopy(source: string, destination: string, expectedSha256: string) {
  if ((await sha256File(source)) !== expectedSha256) throw new Error("QUALIFICATION_ARTIFACT_CHANGED")
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  if ((await sha256File(destination)) !== expectedSha256) throw new Error("QUALIFICATION_ARTIFACT_COPY_MISMATCH")
  await chmod(destination, 0o700)
  return destination
}

export function verifyWindowsVersionInfo(input: unknown, version: string) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/.test(version) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    throw new Error("QUALIFICATION_WINDOWS_VERSION_INVALID")
  const value = input as Record<string, unknown>
  // Pinned electron-builder 26.15.2 preserves FileVersion's prerelease string,
  // while its PE ProductVersion is the numeric core plus the default build 0.
  if (
    value.ProductName !== "Physical Systems Candidate" ||
    value.FileVersion !== version ||
    value.ProductVersion !== `${version.split("-")[0]}.0`
  )
    throw new Error("QUALIFICATION_WINDOWS_VERSION_MISMATCH")
  return { productName: value.ProductName, fileVersion: value.FileVersion, productVersion: value.ProductVersion }
}

/** Bind receipts to the executable and every bundled resource, including native binaries. */
export async function payloadFingerprint(executable: string) {
  const root = resolve(executable, "..")
  const files: string[] = [executable]
  async function walk(folder: string) {
    const stat = await lstat(folder)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("QUALIFICATION_PAYLOAD_SYMLINK")
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name)
      if (entry.isSymbolicLink()) throw new Error("QUALIFICATION_PAYLOAD_SYMLINK")
      if (entry.isDirectory()) await walk(file)
      if (entry.isFile()) files.push(file)
    }
  }
  await walk(join(root, "resources"))
  const entries = await Promise.all(
    files
      .sort()
      .map(async (file) => ({ path: relative(root, file).replaceAll("\\", "/"), sha256: await sha256File(file) })),
  )
  return {
    executableSha256: await sha256File(executable),
    sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
  }
}

/** Do not inherit shell profiles or credential-bearing environment variables. */
export function qualificationEnvironment(
  input: NodeJS.ProcessEnv,
  root: string,
  platform: NodeJS.Platform = process.platform,
) {
  const allowed = [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ]
  const result: NodeJS.ProcessEnv = Object.fromEntries(
    allowed.flatMap((key) => (input[key] ? [[key, input[key]]] : [])),
  )
  const windows = input.SystemRoot || input.SYSTEMROOT || "C:\\Windows"
  return Object.assign(result, {
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    TMPDIR: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
    // An empty, owned directory proves no system Node/Bun executable is needed.
    PATH: join(root, "empty-path"),
    ...(platform === "win32" ? { SystemRoot: windows, WINDIR: windows, COMSPEC: `${windows}\\System32\\cmd.exe` } : {}),
    PHYSICALSYSTEMS_DATA_DIR: root,
    PHYSICALSYSTEMS_ALLOW_DEVICES: "0",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  })
}

export function qualificationReport(input: {
  artifact: string
  artifactSha256: string
  artifactBytes: number
  version: string
  checks: QualificationCheck[]
  signature: SignatureResult
  payload?: { sha256: string; executableSha256: string }
  inputsSha256?: string
  sourceRevision?: string
  windowsVersion?: { productName: string; fileVersion: string; productVersion: string }
}) {
  const result: QualificationStatus = input.checks.some((check) => check.status === "FAIL")
    ? "FAIL"
    : input.checks.some((check) => check.status === "BLOCKED")
      ? "BLOCKED"
      : requiredQualificationChecks.some(
            (id) => !input.checks.some((check) => check.id === id && check.status === "PASS"),
          )
        ? "NOT_TESTED"
        : "PASS"
  return {
    schemaVersion: 1,
    artifact: { name: basename(input.artifact), sha256: input.artifactSha256, bytes: input.artifactBytes },
    version: input.version,
    platform: `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    result,
    simulationOnly: true,
    deviceConnectionsAllowed: false,
    opticalFlickerMeasured: false,
    // Preview identity, signing and actual hardware qualification remain separate release decisions.
    publicDistribution: {
      status: "BLOCKED" as const,
      reason: "Internal candidate: public identity, signing and release approval are not qualified by this test.",
    },
    inputsSha256: input.inputsSha256,
    sourceRevision: input.sourceRevision,
    signature: input.signature,
    payload: input.payload,
    windowsVersion: input.windowsVersion,
    checks: input.checks,
  }
}
