// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { constants, createReadStream } from "node:fs"
import { chmod, copyFile, lstat, readFile, readdir } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
import { desktopIdentity } from "./identity"
import { startupPhases, type StartupPhase } from "./startup-phases"

export type QualificationStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_TESTED"
export type QualificationCheck = {
  id: string
  status: QualificationStatus
  detail: string
  failureCode?: QualificationFailureCode
}
export type SignatureResult = { status: QualificationStatus; trust: string; signerThumbprint?: string }
// Only authored diagnostic literals may leave a disposable runner. Native error
// messages and stacks can contain private paths, provider output or credentials.
export const qualificationFailureCodes = [
  "BROWSER_HANDOFF_UNCONFIRMED",
  "BROWSER_HANDOFF_CLEANUP_UNCONFIRMED",
  "PROVIDER_REVIEW_UNCONFIRMED",
  "PROVIDER_REVIEW_ACCOUNT_UNCONFIRMED",
  "PROVIDER_REVIEW_CLEANUP_UNCONFIRMED",
  "PROVIDER_REVIEW_BROWSER_UNCONFIRMED",
  "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED",
  "PROVIDER_REVIEW_WINDOWS_UNCONFIRMED",
  "APPIMAGE_REPLACEMENT_UNCONFIRMED",
  "APPIMAGE_REINSTALL_SHUTDOWN_UNCONFIRMED",
  "APPIMAGE_REINSTALL_STATE_CHANGED",
  "APPIMAGE_RUNTIME_ARTIFACT_CHANGED",
  "APPIMAGE_RUNTIME_CACHE_NOT_EMPTY",
  "APPIMAGE_RUNTIME_CLEANUP_UNCONFIRMED",
  "APPIMAGE_RUNTIME_OWNER_UNCONFIRMED",
  "APPIMAGE_RUNTIME_PATH_INVALID",
  "APPIMAGE_RUNTIME_PAYLOAD_CHANGED",
  "APPIMAGE_RUNTIME_UNSUPPORTED",
  "V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED",
  "V2_CREDENTIAL_PROBE_SAVE_PREFLIGHT_UNCONFIRMED",
  "V2_CREDENTIAL_PROBE_SAVE_METHOD_UNCONFIRMED",
  "V2_CREDENTIAL_PROBE_SAVE_WRITE_UNCONFIRMED",
  "V2_CREDENTIAL_PROBE_SAVE_READBACK_UNCONFIRMED",
  "V2_CREDENTIAL_PROBE_OBSERVATION_INVALID",
  "V2_CREDENTIAL_PROBE_CATALOG_UNCONFIRMED",
  "V2_CREDENTIAL_PROBE_MODEL_UNCONFIRMED",
  "V2_CREDENTIAL_PROBE_DISPATCH_UNCONFIRMED",
  "V2_CREDENTIAL_PROBE_STORAGE_UNCONFIRMED",
  "V2_CREDENTIAL_PROBE_REMOVAL_UNCONFIRMED",
  "V2_CREDENTIAL_PROBE_PROVIDER_INVALID",
  "CREDENTIAL_PROBE_AUTH_UNCONFIRMED",
  "CREDENTIAL_PROBE_BACKEND_UNCONFIRMED",
  "CREDENTIAL_PROBE_RESTART_UNCONFIRMED",
  "CREDENTIAL_PROBE_RETRIEVAL_UNCONFIRMED",
  "CREDENTIAL_PROBE_STORAGE_UNCONFIRMED",
  "LINUX_SECRET_SERVICE_TIMEOUT_INVALID",
  "LINUX_SECRET_SERVICE_CLEANUP_UNCONFIRMED",
  "LINUX_SECRET_SERVICE_STARTUP_FAILED",
  "LINUX_SECRET_SERVICE_READINESS_UNCONFIRMED",
  "LINUX_SECRET_SERVICE_PATH_INVALID",
  "LINUX_SECRET_SERVICE_BUS_OWNER_MISMATCH",
  "LINUX_SECRET_SERVICE_EXISTING_SERVICE",
  "LINUX_SECRET_SERVICE_UNLOCK_UNCONFIRMED",
  "LINUX_SECRET_SERVICE_SERVICE_OWNER_MISMATCH",
  "INSTALLER_SIGNATURE_INVALID",
  "LINUX_QUALIFICATION_REQUIRES_LINUX",
  "LINUX_QUALIFICATION_REQUIRES_DISPOSABLE_RUNNER",
  "LINUX_QUALIFICATION_PATH_OUTSIDE_RUNNER",
  "LINUX_QUALIFICATION_TEMP_PATH_INVALID",
  "LINUX_QUALIFICATION_TEMP_OWNERSHIP_INVALID",
  "LINUX_QUALIFICATION_DEBIAN_IDENTITY_INVALID",
  "LINUX_QUALIFICATION_PACKAGE_STATUS_INVALID",
  "LINUX_QUALIFICATION_PACKAGE_ALREADY_PRESENT",
  "LINUX_QUALIFICATION_PROFILE_PATH_INVALID",
  "LINUX_QUALIFICATION_PROFILE_ALREADY_PRESENT",
  "LINUX_QUALIFICATION_PROFILE_NOT_LOADED",
  "LINUX_QUALIFICATION_PROFILE_RETAINED",
  "LINUX_QUALIFICATION_INSTALLED_PAYLOAD_MISMATCH",
  "OWNED_UNINSTALL_NOT_COMPLETE",
  "PACKAGED_ARCHIVE_DEPENDENCY_UNAVAILABLE",
  "PACKAGED_ARCHIVE_MEMBER_INVALID",
  "PACKAGED_APPROVAL_GATE_BYPASSED",
  "PACKAGED_APPROVAL_NOT_READY",
  "PACKAGED_APP_SHUTDOWN_UNCONFIRMED",
  "PACKAGED_APP_EXITED_BEFORE_READY",
  "PACKAGED_APP_SPAWN_FAILED",
  "PACKAGED_APPIMAGE_LAUNCHER_INVALID",
  "PACKAGED_APPIMAGE_DESKTOP_ENTRY_INVALID",
  "PACKAGED_ATTACHMENT_OWNER_INVALID",
  "PACKAGED_ATTACHMENT_UNCONFIRMED",
  "PACKAGED_ATTACHMENT_RETAINED",
  "PACKAGED_CDP_CONNECTION_FAILED",
  "PACKAGED_CDP_CONNECTION_TIMEOUT",
  "PACKAGED_CDP_REQUEST_FAILED",
  "PACKAGED_CDP_TIMEOUT",
  "PACKAGED_COMPOSER_UNAVAILABLE",
  "PACKAGED_CONVERSATION_NOT_RESTORED",
  "PACKAGED_CONVERSATION_NOT_READY",
  "PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE",
  "PACKAGED_DEBUG_ENDPOINT_INVALID",
  "PACKAGED_DISPLAY_UNAVAILABLE",
  "PACKAGED_DESCENDANT_RETAINED",
  "PACKAGED_SHUTDOWN_DIAGNOSTIC_UNCONFIRMED",
  "PACKAGED_EXECUTABLE_NOT_UNIQUE",
  "PACKAGED_PROFILE_NOT_ISOLATED",
  "PACKAGED_PROMPT_NOT_ADMITTED",
  "PACKAGED_PUBLIC_INPUTS_INVALID",
  "PACKAGED_PUBLIC_IDENTITY_MISMATCH",
  "PACKAGED_PUBLIC_SIGNATURE_INVALID",
  "PACKAGED_PUBLIC_SIGNATURE_POLICY_MISMATCH",
  "PACKAGED_LINUX_RENDERER_SANDBOX_UNCONFIRMED",
  "PACKAGED_MAIN_PROCESS_EXCEPTION",
  "PACKAGED_MODULE_INITIALIZATION_FAILED",
  "PACKAGED_MODEL_NOT_READY",
  "PACKAGED_OPERATOR_STARTUP_FAILED",
  "PACKAGED_PROJECT_DIALOG_UNAVAILABLE",
  "PACKAGED_PROJECT_NOT_CREATED",
  "PACKAGED_PROPOSAL_UNAVAILABLE",
  "PACKAGED_RELOAD_CHANGED_OWNERSHIP",
  "PACKAGED_RELOAD_UNAVAILABLE",
  "PACKAGED_REINSTALL_STATE_CHANGED",
  "PACKAGED_REINSTALL_PATH_INVALID",
  "PACKAGED_REINSTALL_FORMAT_INVALID",
  "PACKAGED_REINSTALL_SHUTDOWN_UNCONFIRMED",
  "PACKAGED_REINSTALL_PAYLOAD_CHANGED",
  "PACKAGED_RENDERER_EVALUATION_FAILED",
  "PACKAGED_RENDERER_UNAVAILABLE",
  "PACKAGED_RUNTIME_FILE_EMPTY",
  "PACKAGED_RUNTIME_JSON_INVALID",
  "PACKAGED_RUNTIME_READ_FAILED",
  "PACKAGED_SANDBOX_INITIALIZATION_FAILED",
  "PACKAGED_SHARED_LIBRARY_UNAVAILABLE",
  "PACKAGED_SKILL_HASH_MISMATCH",
  "PACKAGED_TRIAL_EVIDENCE_INVALID",
  "PACKAGED_TRIALS_NOT_COMPLETE",
  "PACKAGED_VERSION_MISMATCH",
  "PACKAGED_WORKSPACE_UNAVAILABLE",
  "PAYLOAD_SIGNATURE_INVALID",
  "PLATFORM_DISPLAY_CAPTURE_UNCONFIRMED",
  "PLATFORM_DISPLAY_COMPOSER_UNAVAILABLE",
  "PLATFORM_DISPLAY_DECODE_UNCONFIRMED",
  "PLATFORM_DISPLAY_DIMENSIONS_UNCONFIRMED",
  "PLATFORM_DISPLAY_FRAME_UNCONFIRMED",
  "PLATFORM_DISPLAY_GEOMETRY_UNCONFIRMED",
  "PLATFORM_DISPLAY_FOCUS_UNCONFIRMED",
  "PLATFORM_DISPLAY_INPUT_UNCONFIRMED",
  "PLATFORM_DISPLAY_NONDEFAULT_ARGUMENTS",
  "PLATFORM_DISPLAY_PAINT_UNCONFIRMED",
  "PLATFORM_DISPLAY_PROBE_UNCONFIRMED",
  "PLATFORM_DISPLAY_RESTORE_UNCONFIRMED",
  "PLATFORM_DISPLAY_SESSION_UNSUPPORTED",
  "PLATFORM_DISPLAY_TIMEOUT",
  "PLATFORM_DISPLAY_WINDOW_UNCONFIRMED",
  "QUALIFICATION_ARTIFACT_CHANGED",
  "QUALIFICATION_ARTIFACT_COPY_MISMATCH",
  "QUALIFICATION_COMMAND_FAILED",
  "QUALIFICATION_COMMAND_OUTPUT_LIMIT",
  "QUALIFICATION_COMMAND_TIMEOUT",
  "QUALIFICATION_COMMAND_UNAVAILABLE",
  "QUALIFICATION_PAYLOAD_SYMLINK",
  "QUALIFICATION_REGULAR_FILE_REQUIRED",
  "PUBLIC_UPGRADE_ARTIFACT_CHANGED",
  "PUBLIC_UPGRADE_BASELINE_INVALID",
  "PUBLIC_UPGRADE_BASELINE_UNCONFIRMED",
  "PUBLIC_UPGRADE_DEBIAN_STATE_UNCONFIRMED",
  "PUBLIC_UPGRADE_FORMAT_INVALID",
  "PUBLIC_UPGRADE_INPUT_MISSING",
  "PUBLIC_UPGRADE_INPUT_INVALID",
  "PUBLIC_UPGRADE_INPUT_BINDING_INVALID",
  "PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED",
  "PUBLIC_UPGRADE_INSTALLER_TIMEOUT",
  "PUBLIC_UPGRADE_INSTALLER_DESCENDANT_RETAINED",
  "PUBLIC_UPGRADE_INSTALLER_FAILED",
  "PUBLIC_UPGRADE_INTERRUPTION_UNOBSERVED",
  "PUBLIC_UPGRADE_INTERRUPTION_UNCONFIRMED",
  "PUBLIC_UPGRADE_QUALIFICATION_INVALID",
  "PUBLIC_UPGRADE_SHUTDOWN_UNCONFIRMED",
  "PUBLIC_UPGRADE_SIGNATURE_UNCONFIRMED",
  "PUBLIC_UPGRADE_STATE_CHANGED",
  "PUBLIC_UPGRADE_TARGET_UNCONFIRMED",
  "PUBLIC_UPGRADE_TIMEOUT_INVALID",
  "QUALIFICATION_UNEXPECTED_ERROR",
  "QUALIFICATION_WINDOWS_VERSION_INVALID",
  "QUALIFICATION_WINDOWS_VERSION_MISMATCH",
  "PUBLIC_QUALIFICATION_REQUIRES_DISPOSABLE_RUNNER",
  "PUBLIC_QUALIFICATION_PATH_OUTSIDE_RUNNER",
  "UNINSTALLER_MISSING",
  "UNINSTALL_UNCONFIRMED",
  "UNSUPPORTED_CANDIDATE_PACKAGE",
  "WINDOWS_QUALIFICATION_REQUIRES_WINDOWS",
] as const
export type QualificationFailureCode = (typeof qualificationFailureCodes)[number]

export function isQualificationFailureCode(value: unknown): value is QualificationFailureCode {
  return qualificationFailureCodes.some((code) => code === value)
}

export function qualificationFailureCode(error: unknown): QualificationFailureCode {
  return error instanceof Error && isQualificationFailureCode(error.message)
    ? error.message
    : "QUALIFICATION_UNEXPECTED_ERROR"
}

/** Observe only the owned process's startup; no raw output leaves this closure. */
export function observePackagedStartup(child: ChildProcess) {
  let tail = ""
  let port: number | undefined
  let phase: StartupPhase | undefined
  let stderrTail = ""
  let failure: QualificationFailureCode | undefined
  const collectOutput = (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-16384)
  }
  const collect = (chunk: Buffer | string) => {
    collectOutput(chunk)
    stderrTail = (stderrTail + chunk.toString()).slice(-16384)
    for (const match of stderrTail.matchAll(/^PHYSICALSYSTEMS_STARTUP_([A-Z_]+)\r?\n/gm))
      if (startupPhases.some((value) => value === match[1])) phase = match[1] as StartupPhase
    // Electron can start CDP before application code selects userData. Read only
    // the owned process's exact loopback announcement; never return its raw URL.
    const matches = tail.matchAll(
      /^DevTools listening on ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/devtools\/browser\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\r?$/gm,
    )
    for (const match of matches) if (Number(match[1]) <= 65535) port = Number(match[1])
  }
  const diagnostic = (): QualificationFailureCode | undefined =>
    /The SUID sandbox helper binary was found, but is not configured correctly|No usable sandbox!|Failed to move to new namespace|Failed to unshare namespace|Running as root without --no-sandbox is not supported/.test(
      tail,
    )
      ? "PACKAGED_SANDBOX_INITIALIZATION_FAILED"
      : /error while loading shared libraries:/.test(tail)
        ? "PACKAGED_SHARED_LIBRARY_UNAVAILABLE"
        : /Missing X server or \$DISPLAY|The platform failed to initialize/.test(tail)
          ? "PACKAGED_DISPLAY_UNAVAILABLE"
          : /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_DLOPEN_FAILED)\b|Module did not self-register/.test(
                tail,
              )
            ? "PACKAGED_MODULE_INITIALIZATION_FAILED"
            : /\b(?:OPERATOR_SERVICE_UNAVAILABLE|OPERATOR_REQUEST_UNCONFIRMED|OPERATOR_PARENT_REQUIRED)\b/.test(tail)
              ? "PACKAGED_OPERATOR_STARTUP_FAILED"
              : /A JavaScript error occurred in the main process|Uncaught Exception:|\(FiberFailure\)/.test(tail)
                ? "PACKAGED_MAIN_PROCESS_EXCEPTION"
                : undefined
  const spawnFailed = () => {
    failure = "PACKAGED_APP_SPAWN_FAILED"
  }
  const closed = () => {
    failure ||= diagnostic() || "PACKAGED_APP_EXITED_BEFORE_READY"
    tail = ""
  }
  child.stderr?.on("data", collect)
  child.stdout?.on("data", collectOutput)
  child.once("error", spawnFailed)
  // close follows the final stderr chunk; exit can precede it.
  child.once("close", closed)
  return {
    assertRunning() {
      if (failure) throw new Error(failure)
    },
    debugPort() {
      return port
    },
    startupPhase() {
      return phase
    },
    timeoutCode(fallback: QualificationFailureCode) {
      // A native error dialog can keep the process alive. Classify its stderr
      // only after readiness expires; a warning cannot abort a healthy startup.
      return failure || diagnostic() || fallback
    },
    dispose() {
      child.stderr?.off("data", collect)
      child.stdout?.off("data", collectOutput)
      child.off("error", spawnFailed)
      child.off("close", closed)
      tail = ""
      stderrTail = ""
      port = undefined
      phase = undefined
    },
  }
}

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

/** Inspect the final package's entry point without executing it. */
export async function verifyAppImageLauncher(
  folder: string,
  reviewedSource: string,
  kind: "candidate" | "public" = "candidate",
) {
  const identity = desktopIdentity(kind)
  if (basename(reviewedSource) !== identity.launcherSource) throw new Error("PACKAGED_APPIMAGE_LAUNCHER_INVALID")
  const launcher = join(folder, "AppRun")
  const stat = await lstat(launcher)
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111))
    throw new Error("PACKAGED_APPIMAGE_LAUNCHER_INVALID")
  const [expected, actual] = await Promise.all([sha256File(reviewedSource), sha256File(launcher)])
  if (expected !== actual) throw new Error("PACKAGED_APPIMAGE_LAUNCHER_INVALID")
  const desktop = join(folder, identity.desktopEntry)
  const entry = await lstat(desktop)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("PACKAGED_APPIMAGE_DESKTOP_ENTRY_INVALID")
  const text = await readFile(desktop, "utf8")
  const commands = text.split(/\r?\n/).filter((line) => /^\s*(?:Exec|TryExec)\s*=/.test(line))
  if (commands.length !== 1 || commands[0] !== "Exec=AppRun %U")
    throw new Error("PACKAGED_APPIMAGE_DESKTOP_ENTRY_INVALID")
  return { launcher, sha256: actual }
}

/** Download artifacts may lose mode bits. Never chmod the immutable input itself. */
export async function executableArtifactCopy(source: string, destination: string, expectedSha256: string) {
  if ((await sha256File(source)) !== expectedSha256) throw new Error("QUALIFICATION_ARTIFACT_CHANGED")
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  if ((await sha256File(destination)) !== expectedSha256) throw new Error("QUALIFICATION_ARTIFACT_COPY_MISMATCH")
  await chmod(destination, 0o700)
  return destination
}

export function verifyWindowsVersionInfo(input: unknown, version: string, kind: "candidate" | "public" = "candidate") {
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
    value.ProductName !== desktopIdentity(kind).productName ||
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
    PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1",
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
  if (
    input.checks.some(
      (check) =>
        check.failureCode !== undefined && (check.status !== "FAIL" || !isQualificationFailureCode(check.failureCode)),
    )
  )
    throw new Error("Invalid qualification failure diagnostic")
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
