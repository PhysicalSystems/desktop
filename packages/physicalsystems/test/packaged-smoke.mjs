// SPDX-License-Identifier: Apache-2.0
// Tests the executable extracted from the named installer, never a separate build.
// Profiles, raw logs and private attachment files stay outside repository/artifacts.
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  lstat,
  realpath,
  unlink,
  readlink,
} from "node:fs/promises"
import { constants, createWriteStream } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { Transform } from "node:stream"
import { qualificationPrompt, startFixtureProvider } from "./fixture-provider.mjs"
import { composerReadiness, composerSelection } from "../src/release/composer-readiness.ts"
import { probePackagedRenderer } from "../src/release/cdp-discovery.ts"
import { allocateLinuxQualificationTemporary } from "../src/release/linux-temporary.ts"
import { openPackagedArchive } from "../src/release/packaged-archive.ts"
import { fixtureCheckpointDetail } from "../src/release/fixture-checkpoint.ts"
import { legacyApprovalReady } from "../src/release/approval-readiness.ts"
import { observePrivateLog, startupCheckpointDetail } from "../src/release/startup-observation.ts"
import { isDiagnosticsPublicKey, sealDiagnostics } from "../src/release/sealed-diagnostics.ts"
import { windowsAppShutdownNative } from "../src/release/windows-app-shutdown-native.ts"
import { classifyWindowsAppShutdown } from "../src/release/windows-app-shutdown-observation.ts"
import { captureLinuxAppShutdown } from "../src/release/linux-app-shutdown-observation.ts"
import { observeShutdownTrace } from "../src/release/shutdown-trace.ts"
import { desktopIdentity } from "../src/release/identity.ts"
import { agentDatabaseName } from "../src/release/agent-channel.ts"
import { waitForCredentialAttachment } from "../src/release/native-credentials.ts"
import { createNativeV2CredentialProbe } from "../src/release/native-credentials-v2.ts"
import { ownedV2CredentialTransport } from "../src/release/native-v2-transport.ts"
import { createV2CredentialReadiness, createV2RemovalReadiness } from "../src/release/native-v2-readiness.ts"
import { createV2TransportObservation } from "../src/release/native-v2-observation.ts"
import { observeCredentialBackend } from "../src/release/credential-backend.ts"
import {
  nsisInstallArguments,
  nsisSpawnOptions,
  nsisUninstallArguments,
  qualifyInstalledReinstall,
} from "../src/release/installed-reinstall.ts"
import { startLinuxSecretService } from "../src/release/linux-secret-service.ts"
import { qualifyPlatformDisplay } from "../src/release/platform-display.ts"
import { prepareAppImageRuntime, bindAppImageElectron } from "../src/release/appimage-runtime.ts"
import { qualifyInstalledUpgrade, requireDebianUpgradeStatus } from "../src/release/installed-upgrade.ts"
import { runNativeUpgradeInstaller } from "../src/release/native-upgrade-process.ts"
import {
  upgradeQualificationArguments,
  loadPublicUpgradeQualification,
} from "../src/release/public-upgrade-qualification.ts"
import { prepareAppImageReplacement } from "../src/release/appimage-replacement.ts"
import { qualifyAppImageReinstall } from "../src/release/appimage-reinstall.ts"
import { runOwnedProviderBrowserReview } from "../src/release/owned-provider-review.ts"
import { runOwnedBrowserHandoffReview } from "../src/release/owned-browser-handoff.ts"
import { readBrowserObservation } from "../src/release/browser-observation.ts"
import {
  loadPublicQualification,
  requireDisposablePublicRunner,
  verifyPublicAuthenticode,
  verifyPublicSignaturePair,
  verifyPublicPackagedIdentity,
  unqualifiedPublicSmokeReport,
} from "../src/release/public-qualification.ts"
import {
  authenticodeResult,
  executableArtifactCopy,
  observePackagedStartup,
  payloadFingerprint,
  qualificationEnvironment,
  qualificationFailureCode,
  qualificationReport,
  sha256File,
  verifyAppImageLauncher,
  verifyWindowsVersionInfo,
} from "../src/release/qualification.ts"
import {
  debianCandidatePlan,
  debianProfileIsLoaded,
  profileIsLoaded,
  requireAbsentDebianCandidate,
  requireDisposableLinuxRunner,
  verifyLinuxRendererSandbox,
} from "../src/release/linux-qualification.ts"

const { options, upgrade: upgradeOptions } = upgradeQualificationArguments(process.argv.slice(2))
const publicMode = await loadPublicQualification(options)
const publicUpgrade = await loadPublicUpgradeQualification(upgradeOptions, publicMode)
const identity = desktopIdentity(publicMode ? "public" : "candidate")
for (const key of ["artifact", "evidence", "report"])
  if (!isAbsolute(options[key])) throw new Error("QUALIFICATION_ABSOLUTE_PATH_REQUIRED")
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
if ([options.evidence, options.report].some((file) => resolve(file) === repo || resolve(file).startsWith(repo + sep)))
  throw new Error("QUALIFICATION_EVIDENCE_MUST_BE_OUTSIDE_REPOSITORY")
if (!options.inspectionOnly && process.env.CI !== "true") throw new Error("PACKAGED_LAUNCH_REQUIRES_DISPOSABLE_CI")
await mkdir(options.evidence, { recursive: true, mode: 0o700 })
await mkdir(dirname(options.report), { recursive: true })
const root = await mkdtemp(join(options.evidence, "packaged-"))
const checks = []
const check = (id, status, detail, failureCode) => {
  const value = { id, status, detail, ...(failureCode ? { failureCode } : {}) }
  const index = checks.findIndex((entry) => entry.id === id)
  if (index >= 0) checks[index] = value
  else checks.push(value)
}
const mainCheck = check
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const artifactSha256 = await sha256File(options.artifact)
const artifactBytes = (await lstat(options.artifact)).size
let signature = { status: "NOT_TESTED", trust: "NOT_APPLICABLE_TO_LINUX_PACKAGE" }
let payload
let embeddedInputs
let windowsVersion
let installerSignatureObservation
let publicSigning
let publicCompiledIdentity
let installed
let nsisUninstallerSha256
let nsisUninstallCopies = 0
let reinstallBefore
let reinstallAfter
let mainPreservedPinchZoom
const upgradeInstallationState = { unconfirmed: false }
const reinstallInstallationState = { unconfirmed: false }
let linuxInstallation
let linuxSandboxProfile
let linuxTemporary
let appImageRuntime
let appImageRuntimeCleanup = false
const appImageReplacementState = { unconfirmed: false }
let providerReviewCleanupUnconfirmed = false
let windowsShutdownQuery
let windowsShutdownPrivate
const privateShutdownRecipient = isDiagnosticsPublicKey(process.env.PS_DIAGNOSTIC_PUBLIC_KEY_PEM || "")
let secretService
const credentialProbe = createNativeV2CredentialProbe({ providerID: "openai" })
const credentialState = {
  pids: [],
  saved: undefined,
  removed: undefined,
  backend: undefined,
  sessionId: undefined,
  experimentId: undefined,
  absence: undefined,
}
let applicationStarted = false
let systemMutationUnconfirmed = false
let diagnosticLogStatus = "NOT_STARTED"
let failed
let stage = "artifact-integrity"
check(stage, "PASS", "SHA-256 recorded for the exact package supplied to this test.")

async function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], ...options })
    let output = ""
    let truncated = false
    const collect = (chunk) => {
      output += chunk
      if (output.length > 1024 * 1024) {
        truncated = true
        output = output.slice(-1024 * 1024)
      }
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("QUALIFICATION_COMMAND_TIMEOUT"))
    }, 120000)
    child.once("error", () => {
      clearTimeout(timer)
      reject(new Error("QUALIFICATION_COMMAND_UNAVAILABLE"))
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (truncated) return reject(new Error("QUALIFICATION_COMMAND_OUTPUT_LIMIT"))
      code === 0 ? resolve(output) : reject(new Error("QUALIFICATION_COMMAND_FAILED"))
    })
  })
}
async function signatureObservation(file) {
  // Literal path travels in a private child env, not interpolated PowerShell code.
  const value = await command(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      publicMode
        ? "$s = Get-AuthenticodeSignature -LiteralPath $env:PS_QUALIFICATION_SIGNATURE_FILE; $publisher = if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { $null }; @{ Status=$s.Status.ToString(); Thumbprint=$s.SignerCertificate.Thumbprint; Publisher=$publisher } | ConvertTo-Json -Compress"
        : "$s = Get-AuthenticodeSignature -LiteralPath $env:PS_QUALIFICATION_SIGNATURE_FILE; @{ Status=$s.Status.ToString(); Thumbprint=$s.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress",
    ],
    { env: { ...process.env, PS_QUALIFICATION_SIGNATURE_FILE: file } },
  )
  return JSON.parse(value.trim())
}
async function findExecutable(folder, name, depth = 0) {
  if (depth > 7) return []
  const found = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name)
    if (
      entry.isFile() &&
      entry.name === name &&
      (await lstat(join(folder, "resources", "app.asar")).then(
        (value) => value.isFile(),
        () => false,
      ))
    )
      found.push(file)
    if (entry.isDirectory() && entry.name !== "resources") found.push(...(await findExecutable(file, name, depth + 1)))
  }
  return found
}
async function until(fn, label, limit = 60000) {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) return result
    await sleep(150)
  }
  throw new Error(label)
}

try {
  stage = "payload-integrity"
  if (publicMode && !options.inspectionOnly) await requireDisposablePublicRunner(process.env, root)
  const extension = extname(options.artifact).toLowerCase()
  const extracted = join(root, "payload")
  await mkdir(extracted)
  if (extension === ".exe") {
    if (process.platform !== "win32") throw new Error("WINDOWS_QUALIFICATION_REQUIRES_WINDOWS")
    installerSignatureObservation = await signatureObservation(options.artifact)
    signature = authenticodeResult(installerSignatureObservation)
    if (signature.status === "FAIL") throw new Error("INSTALLER_SIGNATURE_INVALID")
    if (publicMode) verifyPublicAuthenticode(installerSignatureObservation, publicMode.build.windowsSigning)
    if (options.inspectionOnly) {
      check(stage, "NOT_TESTED", "Installer digest and signature inspected; payload installation was not requested.")
    } else {
      // Both owned configs forbid auto-start, elevation and machine-wide install.
      const plan = nsisInstallArguments(extracted)
      await command(options.artifact, plan.args, nsisSpawnOptions(options.artifact))
      installed = extracted
      nsisUninstallerSha256 = await sha256File(await ownedNsisUninstaller(installed))
      check("package-format", "PASS", "NSIS installed per-user into this disposable CI test directory.")
    }
  } else if (extension === ".deb") {
    if (process.platform !== "linux") throw new Error("LINUX_QUALIFICATION_REQUIRES_LINUX")
    await command("dpkg-deb", ["--extract", options.artifact, extracted])
    check(
      "package-format",
      "PASS",
      "Debian payload extracted without installing packages or running maintainer scripts.",
    )
  } else if (extension === ".appimage") {
    if (process.platform !== "linux") throw new Error("LINUX_QUALIFICATION_REQUIRES_LINUX")
    const runnable = await executableArtifactCopy(options.artifact, join(root, "extractable.AppImage"), artifactSha256)
    await command(runnable, ["--appimage-extract"], { cwd: extracted })
    check("package-format", "PASS", "AppImage payload extracted without FUSE, installation, or desktop registration.")
  } else throw new Error("UNSUPPORTED_CANDIDATE_PACKAGE")

  if (!(extension === ".exe" && options.inspectionOnly)) {
    const name =
      options["executable-name"] ||
      (process.platform === "win32" ? `${identity.productName}.exe` : identity.executableName)
    const executables = await findExecutable(extracted, name)
    if (executables.length !== 1) throw new Error("PACKAGED_EXECUTABLE_NOT_UNIQUE")
    const executable = executables[0]
    payload = await payloadFingerprint(executable)
    check(stage, "PASS", "Executable and every bundled resource fingerprinted from the named package payload.")
    if (extension === ".appimage") {
      stage = "appimage-launcher"
      await verifyAppImageLauncher(
        dirname(executable),
        join(repo, "packages/desktop/resources", identity.launcherSource),
        identity.kind,
      )
      check(
        stage,
        "PASS",
        "Final AppImage contains the exact reviewed launcher and a desktop entry with no sandbox-disabling arguments.",
      )
    }
    if (process.platform === "win32") {
      const executableObservation = await signatureObservation(executable)
      const executableSignature = authenticodeResult(executableObservation)
      if (executableSignature.status === "FAIL") throw new Error("PAYLOAD_SIGNATURE_INVALID")
      if (signature.status === "PASS" && executableSignature.status !== "PASS")
        signature = { status: "BLOCKED", trust: "INSTALLER_VALID_PAYLOAD_UNSIGNED" }
      if (publicMode) {
        publicSigning = verifyPublicSignaturePair({
          installer: installerSignatureObservation,
          executable: executableObservation,
          mode: publicMode,
          installerSha256: artifactSha256,
          executableSha256: payload.executableSha256,
        })
        signature = {
          status: "PASS",
          trust: "WINDOWS_AUTHENTICODE_VALID",
          signerThumbprint: publicSigning.installer.certificateThumbprint,
        }
        check(
          "public-signing",
          "PASS",
          "The exact installer and extracted executable have valid Authenticode signatures matching the anchored publisher and signing policy; both certificate identities and byte hashes are recorded.",
        )
      }
    }
    stage = "bundled-runtime"
    const archive = openPackagedArchive(
      join(repo, "packages/desktop/package.json"),
      join(dirname(executable), "resources", "app.asar"),
    )
    const read = archive.read
    for (const file of [
      "out/main/index.js",
      "out/main/physical-worker.js",
      "out/main/sidecar.js",
      "out/main/server/node.js",
      "out/preload/index.js",
      "out/renderer/index.html",
      "out/legal/OpenCode-LICENSE",
      "out/legal/PhysicalSystems-LICENSE",
      "out/legal/PhysicalSystems-NOTICE",
    ])
      if (!read(file).length) throw new Error("PACKAGED_RUNTIME_FILE_EMPTY")
    const manifest = archive.json("out/legal/PhysicalSystems-manifest.json")
    for (const skill of ["inspect-workcell", "transfer-container"])
      for (const name of ["SKILL.md", "physicalsystems.binding.json"]) {
        const file = `skills/${skill}/${name}`
        if (digest(read(`out/main/${file}`)) !== manifest.artifacts?.[file])
          throw new Error("PACKAGED_SKILL_HASH_MISMATCH")
      }
    check(stage, "PASS", "Bundled agent server, operator worker, renderer, licenses and hash-pinned skills inspected.")
    stage = "desktop-version"
    const metadata = archive.json("package.json")
    const release = archive.json("out/legal/desktop-release-inputs.json")
    if (
      metadata.name !== identity.packageName ||
      metadata.version !== options.version ||
      release.version !== options.version ||
      !/^[a-f0-9]{64}$/.test(release.sha256) ||
      !/^[a-f0-9]{40}$/.test(release.source?.revision)
    )
      throw new Error("PACKAGED_VERSION_MISMATCH")
    embeddedInputs = release
    if (publicMode) {
      publicCompiledIdentity = verifyPublicPackagedIdentity(publicMode, {
        metadata,
        releaseInputs: release,
        publicInputs: archive.json("out/legal/public-build-inputs.json"),
        compiledIdentity: archive.json("out/legal/physical-build-identity.json"),
        mainBytes: read("out/main/index.js"),
      })
      check(
        "public-compiled-identity",
        "PASS",
        "The final archive contains the public main process bound to both independently supplied input digests, exact source and version.",
      )
    }
    if (process.platform === "win32") {
      const pe = await command(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$v = (Get-Item -LiteralPath $env:PS_QUALIFICATION_VERSION_FILE).VersionInfo; @{ ProductName=$v.ProductName; FileVersion=$v.FileVersion; ProductVersion=$v.ProductVersion } | ConvertTo-Json -Compress",
        ],
        { env: { ...process.env, PS_QUALIFICATION_VERSION_FILE: executable } },
      )
      windowsVersion = verifyWindowsVersionInfo(JSON.parse(pe.trim()), options.version, identity.kind)
    }
    check(stage, "PASS", "Packaged app metadata and embedded release input match the requested desktop version.")
    if (!options.inspectionOnly) {
      let entrypoint = executable
      if (process.platform === "linux") {
        stage = "linux-sandbox-setup"
        await requireDisposableLinuxRunner(process.env, root)
        if (extension === ".deb") {
          const metadata = await command("dpkg-deb", [
            "--show",
            "--showformat=${Package}\n${Version}\n${Architecture}\n",
            options.artifact,
          ])
          const plan = debianCandidatePlan(options.version, metadata, identity.kind)
          requireAbsentDebianCandidate(await readFile("/var/lib/dpkg/status", "utf8"), identity.kind)
          if (debianProfileIsLoaded(await loadedProfiles(), identity.kind))
            throw new Error("LINUX_QUALIFICATION_PROFILE_ALREADY_PRESENT")
          for (const path of plan.paths)
            if (await exists(path)) throw new Error("LINUX_QUALIFICATION_PACKAGE_ALREADY_PRESENT")
          if ((await sha256File(options.artifact)) !== artifactSha256) throw new Error("QUALIFICATION_ARTIFACT_CHANGED")
          linuxInstallation = plan
          await command("/usr/bin/sudo", ["-n", "/usr/bin/dpkg", "--install", options.artifact]).catch(
            retainUnconfirmedMutation,
          )
          if (!debianProfileIsLoaded(await loadedProfiles(), identity.kind))
            throw new Error("LINUX_QUALIFICATION_PROFILE_NOT_LOADED")
          if ((await payloadFingerprint(plan.executable)).sha256 !== payload.sha256)
            throw new Error("LINUX_QUALIFICATION_INSTALLED_PAYLOAD_MISMATCH")
          entrypoint = plan.executable
          check(
            stage,
            "PASS",
            "Exact Debian package installed on the disposable runner; its own maintainer scripts configured its application-specific sandbox policy. Installed payload matches the extracted artifact.",
          )
        } else {
          if ((await realpath(executable)) !== executable) throw new Error("LINUX_QUALIFICATION_PROFILE_PATH_INVALID")
          linuxTemporary = await allocateLinuxQualificationTemporary(process.env, root)
          appImageRuntime = await prepareAppImageRuntime({
            env: process.env,
            root,
            temporary: linuxTemporary.path,
            artifact: join(root, "extractable.AppImage"),
            artifactSha256,
            kind: identity.kind,
          })
          const profile = appImageRuntime.profile
          await writeFile(profile.file, profile.text, { flag: "wx", mode: 0o600 })
          if (profileIsLoaded(await loadedProfiles(), profile.name))
            throw new Error("LINUX_QUALIFICATION_PROFILE_ALREADY_PRESENT")
          linuxSandboxProfile = profile
          await command("/usr/bin/sudo", [
            "-n",
            "/usr/sbin/apparmor_parser",
            "--add",
            "--skip-cache",
            profile.file,
          ]).catch(retainUnconfirmedMutation)
          if (!profileIsLoaded(await loadedProfiles(), profile.name))
            throw new Error("LINUX_QUALIFICATION_PROFILE_NOT_LOADED")
          entrypoint = appImageRuntime.artifact
          check(
            stage,
            "PASS",
            "Disposable-runner setup grants user namespaces only to the original AppImage runtime’s exact extraction path. The documented extract-and-run mode requires this explicit Ubuntu AppArmor prerequisite; stock Ubuntu double-click/FUSE startup is not qualified.",
          )
        }
      }
      if (process.platform === "linux") {
        stage = "native-secret-service"
        secretService = await startLinuxSecretService(process.env, root).catch((error) => {
          if (error?.message === "LINUX_SECRET_SERVICE_CLEANUP_UNCONFIRMED") systemMutationUnconfirmed = true
          throw error
        })
        linuxTemporary ||= await allocateLinuxQualificationTemporary(process.env, root)
      }
      for (const phase of ["save", "retrieve-remove", "absent"]) {
        await launch(entrypoint, phase)
        if (failed || checks.find((item) => item.id === "cleanup")?.status !== "PASS")
          throw failed || new Error("PACKAGED_APP_SHUTDOWN_UNCONFIRMED")
      }
      check(
        "native-v2-credential-probe",
        "PASS",
        JSON.stringify({
          backend: credentialState.backend,
          confirmedAppShutdowns: 3,
          freshProcesses: new Set(credentialState.pids).size === 3,
          afterRestartAuthorizationMatched: true,
          afterRemovalRestartCredentialAbsent: credentialState.absence,
          api: "v2-integration",
          savedVault: credentialState.saved,
          removedVault: credentialState.removed,
        }),
      )
      if (installed || linuxInstallation) {
        stage = "native-reinstall-probe"
        const windows = installed
        const debian = linuxInstallation
        const result = await qualifyInstalledReinstall({
          env: process.env,
          root,
          format: windows ? "nsis" : "deb",
          artifact: options.artifact,
          artifactSha256,
          payloadSha256: payload.sha256,
          before: reinstallBefore,
          installationState: reinstallInstallationState,
          shutdown: {
            applicationExited: !failed && checks.find((item) => item.id === "cleanup")?.status === "PASS",
            descendantsExited: !failed && checks.find((item) => item.id === "cleanup")?.status === "PASS",
          },
          uninstall: () => (windows ? uninstallNsis(windows) : uninstallDebian(debian)),
          verifyRemoved: async () => {
            if (windows) {
              await verifyNsisRemoved(windows)
              installed = undefined
            } else {
              await verifyDebianRemoved(debian)
              linuxInstallation = undefined
            }
          },
          install: async () => {
            if (windows) {
              installed = windows
              const plan = nsisInstallArguments(windows)
              await command(options.artifact, plan.args, nsisSpawnOptions(options.artifact)).catch(
                retainUnconfirmedMutation,
              )
              if ((await sha256File(await ownedNsisUninstaller(windows))) !== nsisUninstallerSha256)
                throw new Error("PACKAGED_REINSTALL_PAYLOAD_CHANGED")
            } else {
              linuxInstallation = debian
              await command("/usr/bin/sudo", ["-n", "/usr/bin/dpkg", "--install", options.artifact]).catch(
                retainUnconfirmedMutation,
              )
              if (!debianProfileIsLoaded(await loadedProfiles(), identity.kind))
                throw new Error("LINUX_QUALIFICATION_PROFILE_NOT_LOADED")
            }
          },
          installedPayloadSha256: async () =>
            (await payloadFingerprint(windows ? join(windows, `${identity.productName}.exe`) : debian.executable))
              .sha256,
          relaunch: async () => {
            await launch(entrypoint, "reinstall")
            const closed = !failed && checks.find((item) => item.id === "cleanup")?.status === "PASS"
            return { observation: reinstallAfter, applicationExited: closed, descendantsExited: closed }
          },
        })
        check("native-reinstall-probe", "PASS", JSON.stringify(result))
      } else if (appImageRuntime) {
        stage = "native-reinstall-probe"
        const closed = !failed && checks.find((item) => item.id === "cleanup")?.status === "PASS"
        const result = await qualifyAppImageReinstall({
          env: process.env,
          root,
          artifact: options.artifact,
          artifactSha256,
          runnable: appImageRuntime.artifact,
          before: reinstallBefore,
          replacementState: appImageReplacementState,
          shutdown: {
            applicationExited: closed,
            descendantsExited: closed,
            runtimeCacheRemoved: appImageRuntimeCleanup,
          },
          relaunch: async () => {
            await launch(entrypoint, "reinstall")
            const closed = !failed && checks.find((item) => item.id === "cleanup")?.status === "PASS"
            return {
              observation: reinstallAfter,
              applicationExited: closed,
              descendantsExited: closed,
              runtimeCacheRemoved: appImageRuntimeCleanup,
            }
          },
        })
        check("native-reinstall-probe", "PASS", JSON.stringify(result))
      }
      if (publicUpgrade) await qualifyPublicUpgrade(entrypoint, extension)
      await qualifyBrowserReview(entrypoint, "handoff")
      await qualifyBrowserReview(entrypoint, "provider")
    }
  }
} catch (error) {
  failed = error
  const browserObservation = readBrowserObservation(error)
  if (browserObservation) check("native-browser-observation", "NOT_TESTED", JSON.stringify(browserObservation))
  // Fixed diagnostic codes only; raw app output and provider credentials never enter receipts.
  check(
    stage,
    "FAIL",
    "Qualification failed at this boundary; inspect the private CI diagnostic log.",
    qualificationFailureCode(error),
  )
  await writeFile(
    join(root, "diagnostic.txt"),
    String(error?.stack || error) +
      (windowsShutdownPrivate ? `\nWINDOWS_APP_SHUTDOWN_DIAGNOSTIC\n${JSON.stringify(windowsShutdownPrivate)}\n` : ""),
    { mode: 0o600 },
  )
  windowsShutdownPrivate = undefined
} finally {
  const safeToRemove =
    !systemMutationUnconfirmed &&
    !reinstallInstallationState.unconfirmed &&
    !upgradeInstallationState.unconfirmed &&
    !appImageReplacementState.unconfirmed &&
    !providerReviewCleanupUnconfirmed &&
    (!applicationStarted ||
      (checks.find((item) => item.id === "cleanup")?.status === "PASS" && (!appImageRuntime || appImageRuntimeCleanup)))
  if (secretService) {
    try {
      const status = await secretService.close({ applicationExited: safeToRemove, descendantsExited: safeToRemove })
      if (status.status !== "STOPPED") throw new Error("LINUX_SECRET_SERVICE_CLEANUP_UNCONFIRMED")
      check(
        "native-secret-service-cleanup",
        "PASS",
        "Owned Secret Service and private D-Bus exited after confirmed app and descendant shutdown.",
      )
    } catch (error) {
      failed ||= error
      check(
        "native-secret-service-cleanup",
        "FAIL",
        "Owned Secret Service cleanup is unconfirmed; no ambient service was changed.",
        qualificationFailureCode(error),
      )
    }
  }
  if (linuxTemporary) {
    try {
      const status = await linuxTemporary.cleanup({ applicationExited: safeToRemove, descendantsExited: safeToRemove })
      check(
        "linux-temporary-cleanup",
        status === "REMOVED" ? "PASS" : "BLOCKED",
        status === "REMOVED"
          ? "Owned short temporary directory removed after confirming no application was started or the owned application and descendants exited."
          : "Application cleanup is unconfirmed; its private temporary directory was retained.",
      )
    } catch (error) {
      failed ||= error
      check(
        "linux-temporary-cleanup",
        "FAIL",
        "Owned temporary directory cleanup is unconfirmed.",
        qualificationFailureCode(error),
      )
    }
  }
  if (linuxInstallation) {
    if (safeToRemove) {
      try {
        await uninstallDebian(linuxInstallation)
        await verifyDebianRemoved(linuxInstallation)
        check(
          "uninstall",
          "PASS",
          "Owned Debian package purged after confirmed application shutdown; package, installation paths and its AppArmor profile were removed.",
        )
      } catch (error) {
        failed ||= error
        check("uninstall", "FAIL", "Debian package uninstallation is unconfirmed.", qualificationFailureCode(error))
      }
    } else check("uninstall", "BLOCKED", "Application cleanup is unconfirmed; its installed package was retained.")
  }
  if (linuxSandboxProfile) {
    if (safeToRemove) {
      try {
        if (profileIsLoaded(await loadedProfiles(), linuxSandboxProfile.name))
          await command("/usr/bin/sudo", [
            "-n",
            "/usr/sbin/apparmor_parser",
            "--remove",
            "--skip-cache",
            linuxSandboxProfile.file,
          ])
        if (profileIsLoaded(await loadedProfiles(), linuxSandboxProfile.name))
          throw new Error("LINUX_QUALIFICATION_PROFILE_RETAINED")
        check(
          "linux-sandbox-cleanup",
          "PASS",
          "The exact temporary AppImage sandbox profile was removed after confirmed application shutdown.",
        )
      } catch (error) {
        failed ||= error
        check(
          "linux-sandbox-cleanup",
          "FAIL",
          "Temporary AppImage sandbox profile removal is unconfirmed.",
          qualificationFailureCode(error),
        )
      }
    } else
      check(
        "linux-sandbox-cleanup",
        "BLOCKED",
        "Application cleanup is unconfirmed; its scoped sandbox profile was retained.",
      )
  }
  if (installed) {
    if (safeToRemove) {
      try {
        await uninstallNsis(installed)
        await verifyNsisRemoved(installed)
        check(
          "uninstall",
          "PASS",
          "Exact owned NSIS uninstaller exited and its installation directory was removed after confirmed application shutdown.",
        )
      } catch (error) {
        check(
          "uninstall",
          "FAIL",
          "Package uninstallation did not confirm completion.",
          qualificationFailureCode(error),
        )
        failed ||= error
      }
    } else check("uninstall", "BLOCKED", "Cleanup is unconfirmed; the test did not interrupt a retained application.")
  }
  for (const id of [
    "launch",
    "device-isolation",
    "synthetic-chat",
    "inline-approval",
    "reload",
    "cleanup",
    "shared-terminal",
    "provider-login",
    "real-hardware",
  ])
    if (!checks.some((entry) => entry.id === id)) check(id, "NOT_TESTED", "Outside the checks completed by this run.")
  const baseReport = qualificationReport({
    artifact: options.artifact,
    artifactSha256,
    artifactBytes,
    version: options.version,
    checks,
    signature,
    payload: payload && { sha256: payload.sha256, executableSha256: payload.executableSha256 },
    inputsSha256: embeddedInputs?.sha256,
    sourceRevision: embeddedInputs?.source?.revision,
    windowsVersion,
  })
  const report = publicMode
    ? unqualifiedPublicSmokeReport({
        base: baseReport,
        mode: publicMode,
        compiledIdentity: publicCompiledIdentity,
        signing: publicSigning,
      })
    : baseReport
  await writeFile(options.report, JSON.stringify(report, null, 2) + "\n")
  console.log(
    JSON.stringify({
      result: report.result,
      artifact: basename(options.artifact),
      checks: checks.map(({ id, status, failureCode }) => ({ id, status, ...(failureCode ? { failureCode } : {}) })),
    }),
  )
  // Optional encrypted diagnostics are separate from qualification. Only the
  // two direct private log files are eligible; never profiles or attachments.
  let sealedDiagnostic = { status: "DISABLED" }
  if (process.env.PS_DIAGNOSTIC_PUBLIC_KEY_PEM) {
    try {
      const directory = process.env.PS_DIAGNOSTIC_DIRECTORY
      if (!directory || !isAbsolute(directory)) throw new Error("DIAGNOSTIC_DIRECTORY_INVALID")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      sealedDiagnostic = await sealDiagnostics({
        root: await realpath(root),
        publicKeyPem: process.env.PS_DIAGNOSTIC_PUBLIC_KEY_PEM,
        output: join(await realpath(directory), `${artifactSha256}.sealed.json`),
        context: {
          runId: process.env.GITHUB_RUN_ID,
          runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
          sourceRevision: embeddedInputs?.source?.revision || process.env.GITHUB_SHA,
          artifactSha256,
        },
      })
    } catch {
      sealedDiagnostic = { status: "FAILED", reason: "SEALING_REQUEST_FAILED" }
    }
  }
  console.log(JSON.stringify({ sealedDiagnostic, diagnosticLogStatus }))
  if (failed || publicMode) process.exitCode = 1
}

async function qualifyBrowserReview(entrypoint, mode) {
  const handoff = mode === "handoff"
  if (
    handoff
      ? process.env.PS_BROWSER_REVIEW !== "1"
      : !process.env.PS_PROVIDER_REVIEW || process.env.PS_PROVIDER_REVIEW === "disabled"
  )
    return
  const probeID = handoff ? "native-browser-handoff-probe" : "native-provider-browser-probe"
  stage = probeID
  const reviewRoot = join(root, handoff ? "browser-handoff-review" : "provider-review")
  await mkdir(reviewRoot, { mode: 0o700 })
  const lab = {
    profile: join(reviewRoot, "application"),
    probe: createNativeV2CredentialProbe({ providerID: "openai" }),
    state: { pids: [] },
    checks: [],
    payload,
  }
  try {
    const reviewController = handoff ? runOwnedBrowserHandoffReview : runOwnedProviderBrowserReview
    const result = await reviewController({
      env: process.env,
      root: reviewRoot,
      artifact: options.artifact,
      context: {
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        sourceRevision: embeddedInputs?.source?.revision,
        artifactSha256,
        releaseInputsSha256: embeddedInputs?.sha256,
        platform: process.platform === "win32" ? "windows-x64" : "linux-x64",
      },
      runtimeEnvironment: {
        ...qualificationEnvironment(process.env, lab.profile),
        ...linuxTemporary?.environment,
        ...secretService?.environment,
      },
      async withSession(environment, review) {
        await mkdir(lab.profile, { mode: 0o700 })
        let observed
        try {
          await launch(entrypoint, "provider-review", lab, {
            environment,
            probeID,
            projectName: handoff ? "Browser handoff qualification" : "Provider sign-in qualification",
            async review(session) {
              observed = await review(session)
            },
          })
        } finally {
          const cleanup = lab.checks.find((item) => item.id === "cleanup")
          if (cleanup) check("cleanup", cleanup.status, cleanup.detail, cleanup.failureCode)
          if (failed || cleanup?.status !== "PASS" || (appImageRuntime && !appImageRuntimeCleanup)) {
            providerReviewCleanupUnconfirmed = true
            throw new Error("PROVIDER_REVIEW_CLEANUP_UNCONFIRMED")
          }
        }
        return observed
      },
    })
    stage = probeID
    if (handoff && result.status === "OBSERVED" && result.providerSignIn !== "NOT_TESTED")
      throw new Error("PROVIDER_REVIEW_UNCONFIRMED")
    if (result.status === "OBSERVED") check(stage, "PASS", JSON.stringify(result))
    else check(stage, result.status, result.reason)
  } catch (error) {
    stage = probeID
    if (["PROVIDER_REVIEW_CLEANUP_UNCONFIRMED", "BROWSER_HANDOFF_CLEANUP_UNCONFIRMED"].includes(error?.message))
      providerReviewCleanupUnconfirmed = true
    throw error
  }
}

async function launch(executable, credentialPhase, lab, providerReview) {
  stage = "launch"
  const fresh = credentialPhase === "save" || credentialPhase === "provider-review"
  if ((credentialPhase === "provider-review") !== Boolean(providerReview))
    throw new Error("PROVIDER_REVIEW_UNCONFIRMED")
  const profile = lab?.profile || join(root, "profile")
  const probe = lab?.probe || credentialProbe
  const state = lab?.state || credentialState
  const activePayload = lab?.payload || payload
  let preservedPinchZoom = lab ? lab.pinchZoom : mainPreservedPinchZoom
  const check = lab
    ? (id, status, detail, failureCode) => {
        const index = lab.checks.findIndex((item) => item.id === id)
        const value = { id, status, detail, ...(failureCode ? { failureCode } : {}) }
        if (index < 0) lab.checks.push(value)
        else lab.checks[index] = value
      }
    : mainCheck
  if (appImageRuntime) {
    if (executable !== appImageRuntime.artifact) throw new Error("APPIMAGE_RUNTIME_PATH_INVALID")
    appImageRuntimeCleanup = false
    await appImageRuntime.beforeLaunch()
  }
  for (const folder of ["config/opencode", "tmp", "empty-path", "appdata", "localappdata"])
    await mkdir(join(profile, folder), { recursive: true, mode: 0o700 })
  if (!fresh) {
    // Prior shutdown is already confirmed. An old port file must not bind this
    // new process's CDP discovery to the previous instance's closed endpoint.
    for (const folder of ["session", "desktop"]) {
      const file = join(profile, folder, "DevToolsActivePort")
      const stat = await lstat(file).catch((error) => {
        if (error.code !== "ENOENT") throw error
      })
      if (!stat) continue
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("CREDENTIAL_PROBE_RESTART_UNCONFIRMED")
      await unlink(file)
    }
  }
  const provider = await startFixtureProvider({ credentialProbe: probe })
  await writeFile(
    join(profile, "config", "opencode", "opencode.json"),
    JSON.stringify({
      model: "fixture/fixture",
      small_model: "fixture/fixture",
      enabled_providers: ["fixture", probe.providerID],
      provider: {
        ...(!providerReview && {
          [probe.providerID]: {
            name: "Inert native credential probe",
            npm: "@ai-sdk/openai-compatible",
            api: provider.credentialURL,
            options: { baseURL: provider.credentialURL },
            models: { fixture: { name: "Credential transport fixture", limit: { context: 32000, output: 4096 } } },
          },
        }),
        fixture: {
          name: "Local inert qualification fixture",
          npm: "@ai-sdk/openai-compatible",
          api: provider.url,
          options: { baseURL: provider.url, apiKey: "fixture-not-a-secret" },
          models: { fixture: { name: "Synthetic workflow fixture", limit: { context: 32000, output: 4096 } } },
        },
      },
    }),
    { mode: 0o600 },
  )
  const launchArguments = [
    ...(appImageRuntime?.arguments || []),
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${join(profile, "desktop")}`,
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ]
  const child = spawn(executable, launchArguments, {
    cwd: profile,
    env: {
      ...qualificationEnvironment(process.env, profile),
      ...linuxTemporary?.environment,
      ...secretService?.environment,
      ...providerReview?.environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  applicationStarted = true
  let electronPid = appImageRuntime ? undefined : child.pid
  const log = createWriteStream(join(root, "application.log"), { mode: 0o600, flags: "a" })
  const privateLog = observePrivateLog(log)
  // Real OAuth output never enters diagnostic files. Fixed startup/account
  // observers read directly from the owned child and retain authored fields only.
  const privateOutput = () =>
    new Transform({
      transform(_chunk, _encoding, callback) {
        callback()
      },
    })
  const stdoutFilter = providerReview ? privateOutput() : probe.logFilter()
  const stderrFilter = providerReview ? privateOutput() : probe.logFilter()
  child.stdout.pipe(stdoutFilter).pipe(log, { end: false })
  child.stderr.pipe(stderrFilter).pipe(log, { end: false })
  const backend = observeCredentialBackend(child)
  const exited = new Promise((resolve) => {
    child.once("close", resolve)
    child.once("error", resolve)
  })
  const startup = observePackagedStartup(child)
  const shutdownTrace = observeShutdownTrace(child)
  const untilStarted = (fn, label, limit) =>
    until(
      async () => {
        startup.assertRunning()
        const value = await fn()
        startup.assertRunning()
        return value
      },
      label,
      limit,
    ).catch((error) => {
      if (error instanceof Error && error.message === label) throw new Error(startup.timeoutCode(label))
      throw error
    })
  let socket
  let evaluate
  let api
  let owned = []
  let shutdownInitial = { snapshot: { status: "UNREADABLE", processes: [] }, quiescence: "confirmed" }
  let linuxShutdown
  let closeRequest = "not-requested"
  let closeRequestedAt
  let expectedSynthetic
  let attached
  let v2Request
  let credentialReadiness
  let removalReadiness
  const credentialTransportObservation = createV2TransportObservation()
  const attach = async () => {
    const expected = await evaluate(
      "window.api.physicalSystems.snapshot().then(s => ({ sessionId: s.conversation?.sessionId, directory: s.projects.find(p => p.id === s.activeProjectId)?.cwd }))",
    )
    if (!expected.sessionId || !expected.directory) throw new Error("PACKAGED_ATTACHMENT_OWNER_INVALID")
    // Snapshot broadcast precedes the queued atomic attachment write. Wait only
    // for a valid record for this process and exact current conversation; no API
    // request may run against a missing, malformed or foreign attachment.
    attached = await waitForCredentialAttachment(join(profile, "desktop", "runtime-attach.json"), {
      pid: electronPid,
      ...expected,
    })
    v2Request = ownedV2CredentialTransport(attached, undefined, credentialTransportObservation)
    api = async (path, body, init = {}) =>
      fetch(`${attached.url}${path}?directory=${encodeURIComponent(attached.directory)}`, {
        method: init.method || (body === undefined ? "GET" : "POST"),
        headers: {
          Authorization: `Basic ${Buffer.from(`${attached.username}:${attached.password}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: init.signal || AbortSignal.timeout(6000),
      })
  }
  const v2Idle = async () => {
    const result = await v2Request("/api/session/active", { method: "GET" })
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data))
      throw new Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
    return Object.keys(result.data).length === 0
  }
  const preservedState = async () => {
    const state = await evaluate(`window.api.physicalSystems.snapshot().then(async s => ({
      projectId: s.activeProjectId, sessionId: s.conversation?.sessionId,
      experimentId: s.experiments?.current?.id, phase: s.experiments?.current?.phase,
      trials: s.experiments?.current?.trials, pinchZoomEnabled: await window.api.getPinchZoomEnabled(),
    }))`)
    if (
      state.sessionId !== attached.sessionId ||
      state.pinchZoomEnabled !== preservedPinchZoom ||
      !Array.isArray(state.trials) ||
      state.trials.length !== 3 ||
      state.trials.some((trial) => trial.status !== "COMPLETED")
    )
      throw new Error("PACKAGED_REINSTALL_STATE_CHANGED")
    const response = await api(`/session/${attached.sessionId}/message`)
    if (!response.ok) throw new Error("PACKAGED_REINSTALL_STATE_CHANGED")
    const transcript = await response.text()
    if (transcript.length > 4 * 1024 * 1024) throw new Error("PACKAGED_REINSTALL_STATE_CHANGED")
    const messages = JSON.parse(transcript)
    if (
      !Array.isArray(messages) ||
      !messages.length ||
      messages.some((message) => message.info?.sessionID !== attached.sessionId)
    )
      throw new Error("PACKAGED_REINSTALL_STATE_CHANGED")
    return {
      projectId: state.projectId,
      sessionId: state.sessionId,
      experimentId: state.experimentId,
      phase: state.phase,
      trialCount: state.trials.length,
      trialsSha256: digest(JSON.stringify(state.trials)),
      transcriptSha256: digest(JSON.stringify(messages)),
      pinchZoomEnabled: state.pinchZoomEnabled,
    }
  }
  try {
    const port = await untilStarted(async () => {
      const announced = startup.debugPort()
      if (announced) return announced
      for (const folder of ["session", "desktop"]) {
        const value = await readFile(join(profile, folder, "DevToolsActivePort"), "utf8").catch(() => "")
        if (value && /^[0-9]+$/.test(value.split("\n")[0])) return Number(value.split("\n")[0])
      }
    }, "PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE")
    const target = await untilStarted(() => probePackagedRenderer(port), "PACKAGED_RENDERER_UNAVAILABLE")
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PACKAGED_CDP_CONNECTION_TIMEOUT")), 8000)
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer)
          reject(new Error("PACKAGED_CDP_CONNECTION_FAILED"))
        },
        { once: true },
      )
    })
    let id = 0
    const waiting = new Map()
    socket.addEventListener("message", ({ data }) => {
      const value = JSON.parse(data)
      const pending = waiting.get(value.id)
      if (!pending) return
      waiting.delete(value.id)
      value.error ? pending.reject(new Error("PACKAGED_CDP_REQUEST_FAILED")) : pending.resolve(value.result)
    })
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const request = ++id
        const timer = setTimeout(() => {
          waiting.delete(request)
          reject(new Error("PACKAGED_CDP_TIMEOUT"))
        }, 8000)
        waiting.set(request, {
          resolve: (result) => {
            clearTimeout(timer)
            resolve(result)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        socket.send(JSON.stringify({ id: request, method, params }))
      })
    evaluate = async (expression) => {
      const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error("PACKAGED_RENDERER_EVALUATION_FAILED")
      return result.result?.value
    }
    // Invoke real renderer controls and their handlers; this does not assert optical/display behavior.
    const click = (selector) =>
      evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) throw new Error('CONTROL_UNAVAILABLE'); el.scrollIntoView({ block: 'center' }); el.click(); })()`,
      )
    const type = async (selector, text) => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
      await call("Input.insertText", { text })
      await sleep(200)
    }
    await untilStarted(
      () => evaluate('Boolean(document.querySelector("[data-ps-workspace]"))'),
      "PACKAGED_WORKSPACE_UNAVAILABLE",
    )
    startup.dispose()
    if (appImageRuntime) {
      const ids = [child.pid, ...(await descendants(child.pid))]
      const processes = (
        await Promise.all(
          ids.map(async (pid) => {
            try {
              const status = await readFile(`/proc/${pid}/status`, "utf8")
              return {
                pid,
                ppid: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]),
                uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]),
                executable: await readlink(`/proc/${pid}/exe`),
              }
            } catch {
              return undefined
            }
          }),
        )
      ).filter(Boolean)
      electronPid = await bindAppImageElectron({
        runtimePid: child.pid,
        uid: process.getuid(),
        plan: appImageRuntime,
        payloadSha256: activePayload.sha256,
        processes,
      })
      // Observations never establish ownership or authorize later cleanup.
      // Capture process births while the existing runtime binding is available.
      linuxShutdown = await captureLinuxAppShutdown({
        env: process.env,
        root,
        runtime: { pid: child.pid, executable },
        electron: { pid: electronPid, executable: appImageRuntime.executable },
      }).catch(() => undefined)
    }
    if (!electronPid || state.pids.includes(electronPid)) throw new Error("CREDENTIAL_PROBE_RESTART_UNCONFIRMED")
    state.pids.push(electronPid)
    if (process.platform === "linux") {
      verifyLinuxRendererSandbox(
        await Promise.all(
          (await descendants(child.pid)).map(async (pid) => ({
            commandLine: await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
            status: await readFile(`/proc/${pid}/status`, "utf8").catch(() => ""),
          })),
        ),
      )
      check(
        "linux-renderer-sandbox",
        "PASS",
        "Observed renderer processes retain seccomp filtering and no-new-privileges, with no sandbox-disabling arguments.",
      )
    }
    check(
      stage,
      "PASS",
      providerReview
        ? "The separate browser review loaded the actual renderer with its owned OS browser handler. Empty-PATH operation was qualified earlier."
        : "Installed/extracted Electron payload loaded the actual renderer with no Node or Bun on its PATH.",
    )
    stage = "device-isolation"
    const safety = await evaluate(
      "window.api.physicalSystems.snapshot().then(s => ({ enabled: s.deviceConnectionsEnabled, projects: s.projects.length, captures: s.activeCaptures.length, runs: s.activeRuns.length }))",
    )
    if (safety.enabled !== false || safety.projects !== (fresh ? 0 : 1) || safety.captures !== 0 || safety.runs !== 0)
      throw new Error("PACKAGED_PROFILE_NOT_ISOLATED")
    check(
      stage,
      "PASS",
      "Owned private profile reports device connections disabled and no owned hardware operations; only the expected synthetic project may persist.",
    )
    if (!fresh) {
      stage = "native-v2-credential-probe"
      await until(
        () => evaluate("window.api.physicalSystems.snapshot().then(s => Boolean(s.conversation?.sessionId))"),
        "CREDENTIAL_PROBE_RESTART_UNCONFIRMED",
      )
      await attach()
      if (attached.sessionId !== state.sessionId) throw new Error("CREDENTIAL_PROBE_RESTART_UNCONFIRMED")
      if (credentialPhase === "upgrade-read") {
        if (!lab) throw new Error("PUBLIC_UPGRADE_BASELINE_UNCONFIRMED")
        stage = "native-upgrade-probe"
        lab.after = {
          state: await preservedState(),
          vaultSha256: (await probe.inspectFiles(profile, { databaseName: agentDatabaseName })).vaultSha256,
        }
        return
      }
      if (credentialPhase === "reinstall") {
        stage = "native-reinstall-probe"
        reinstallAfter = await preservedState()
        return
      }
      const stored = await probe.inspectFiles(profile, { databaseName: agentDatabaseName })
      const expected = credentialPhase === "retrieve-remove" ? state.saved : state.removed
      if (stored.vaultSha256 !== expected.vaultSha256) throw new Error("CREDENTIAL_PROBE_STORAGE_UNCONFIRMED")
      await until(v2Idle, "CREDENTIAL_PROBE_RESTART_UNCONFIRMED")
      if (credentialPhase === "retrieve-remove") {
        credentialReadiness = createV2CredentialReadiness({
          request: v2Request,
          probe,
          sessionId: attached.sessionId,
          endpoint: provider.credentialURL,
        })
        await credentialReadiness.dispatch()
        await until(() => probe.observationReady(), "CREDENTIAL_PROBE_RETRIEVAL_UNCONFIRMED", 30000)
        await until(v2Idle, "CREDENTIAL_PROBE_RESTART_UNCONFIRMED", 30000)
        probe.finishObservation()
      } else {
        const requestsBefore = provider.calls.length
        removalReadiness = createV2RemovalReadiness({ request: v2Request, probe, endpoint: provider.url })
        await removalReadiness.wait()
        state.absence = await probe.assertRemoved(v2Request)
        if (!(await v2Idle()) || provider.calls.length !== requestsBefore)
          throw new Error("CREDENTIAL_PROBE_RETRIEVAL_UNCONFIRMED")
      }
      const experiment = await evaluate("window.api.physicalSystems.snapshot().then(s => s.experiments?.current)")
      if (experiment?.id !== state.experimentId || experiment?.trials.length !== 3 || experiment.phase !== "COMPLETED")
        throw new Error("CREDENTIAL_PROBE_RESTART_UNCONFIRMED")
      if (credentialPhase === "retrieve-remove") {
        await probe.remove(v2Request)
        await v2Request(`/api/session/${attached.sessionId}/model`, {
          method: "POST",
          body: { model: { providerID: "fixture", id: "fixture" } },
        })
        state.removed = await probe.inspectFiles(profile, { databaseName: agentDatabaseName })
        if (state.removed.vaultSha256 === state.saved.vaultSha256)
          throw new Error("CREDENTIAL_PROBE_STORAGE_UNCONFIRMED")
        const selected = await until(
          () => {
            try {
              return backend.result()
            } catch {
              return undefined
            }
          },
          "CREDENTIAL_PROBE_BACKEND_UNCONFIRMED",
          2500,
        )
        if (selected !== state.backend) throw new Error("CREDENTIAL_PROBE_BACKEND_UNCONFIRMED")
      }
      if (credentialPhase === "absent" && (installed || linuxInstallation || appImageRuntime))
        reinstallBefore = await preservedState()
      return
    }
    stage = "synthetic-chat"
    await click('[aria-label="New project"]')
    await until(
      () => evaluate('Boolean(document.querySelector("dialog[open] input"))'),
      "PACKAGED_PROJECT_DIALOG_UNAVAILABLE",
    )
    await type("dialog[open] input", providerReview ? providerReview.projectName : "Packaged synthetic qualification")
    await click('dialog[open] button[type="submit"]')
    await until(
      () => evaluate('Boolean(document.querySelector("[data-ps-project-row]"))'),
      "PACKAGED_PROJECT_NOT_CREATED",
    )
    const expectedProjectId = await evaluate(
      'document.querySelector("[data-ps-project-row]")?.getAttribute("data-ps-project-row")',
    )
    await click("[data-ps-project-row]")
    await until(
      () => evaluate('Boolean(document.querySelector("[data-component=prompt-input]"))'),
      "PACKAGED_COMPOSER_UNAVAILABLE",
    )
    const waitForComposer = async () => {
      let readiness = "CONVERSATION_NOT_READY"
      await until(async () => {
        readiness = await evaluate(`(async () => {
          const snapshot = await window.api.physicalSystems.snapshot();
          const routeKeys = Object.keys(localStorage).filter(key => /^opencode\\.desktop\\.window\\..+\\.last-active-url$/.test(key));
          return (${composerReadiness.toString()})({ expectedProjectId: ${JSON.stringify(expectedProjectId)}, snapshot, routeKeys,
            route: routeKeys.length === 1 ? localStorage.getItem(routeKeys[0]) : null,
            ...(${composerSelection.toString()})(document) });
        })()`)
        return readiness === "READY"
      }, "PACKAGED_CONVERSATION_NOT_READY").catch((error) => {
        if (error.message === "PACKAGED_CONVERSATION_NOT_READY" && readiness === "MODEL_NOT_READY")
          throw new Error("PACKAGED_MODEL_NOT_READY")
        throw error
      })
    }
    await waitForComposer()
    if (providerReview) {
      stage = providerReview.probeID
      await attach()
      await providerReview.review({
        child,
        attachment: attached,
        openBrowser: (url) => evaluate(`window.api.openExternal(${JSON.stringify(url)})`),
      })
      return
    }
    stage = "native-platform-display-probe"
    const display = await qualifyPlatformDisplay({
      env: process.env,
      root,
      targetId: target.id,
      launchArguments,
      call,
      evaluate,
    })
    check(stage, "PASS", JSON.stringify(display))
    stage = "synthetic-chat"
    await type("[data-component=prompt-input]", qualificationPrompt)
    await waitForComposer()
    await click('button[aria-label="Send"]')
    await until(() => provider.calls.some((call) => call.syntheticPrompt === true), "PACKAGED_PROMPT_NOT_ADMITTED")
    await until(
      () => evaluate('Boolean(document.querySelector("[data-ps-approve]"))'),
      "PACKAGED_PROPOSAL_UNAVAILABLE",
      90000,
    )
    const proposed = await evaluate("window.api.physicalSystems.snapshot().then(s => s.experiments?.current)")
    if (proposed?.phase !== "PROPOSED" || proposed.trials.length !== 0)
      throw new Error("PACKAGED_APPROVAL_GATE_BYPASSED")
    expectedSynthetic = { id: proposed.id, planDigest: proposed.planDigest }
    check(
      stage,
      "PASS",
      "Real bundled agent loop used the inert local provider to propose exactly a synthetic experiment; no trial ran before approval.",
    )
    await attach()
    stage = "inline-approval"
    await until(async () => {
      // The composer uses the legacy compatibility route. Its projected
      // checkbox can precede the proposal turn's authoritative idle state.
      return legacyApprovalReady(await api("/session/status"), attached.sessionId, () =>
        evaluate(`window.api.physicalSystems.snapshot().then(s => {
          const current = s.experiments?.current;
          return current?.id === ${JSON.stringify(proposed.id)} &&
            current?.planDigest === ${JSON.stringify(proposed.planDigest)} && current?.phase === "PROPOSED" &&
            document.querySelector(".ps-experiment input[type=checkbox]")?.disabled === false;
        })`),
      )
    }, "PACKAGED_APPROVAL_NOT_READY")
    await click('.ps-experiment input[type="checkbox"]')
    await click("[data-ps-approve]")
    const completed = await until(
      () =>
        evaluate(
          'window.api.physicalSystems.snapshot().then(s => s.experiments?.current?.phase === "COMPLETED" ? s.experiments.current : null)',
        ),
      "PACKAGED_TRIALS_NOT_COMPLETE",
      90000,
    )
    if (
      completed.id !== proposed.id ||
      completed.trials.length !== 3 ||
      completed.trials.some((trial) => trial.status !== "COMPLETED")
    )
      throw new Error("PACKAGED_TRIAL_EVIDENCE_INVALID")
    check(
      stage,
      "PASS",
      "Trusted renderer approval admitted the same plan and the bundled service recorded three completed synthetic trials.",
    )
    stage = "reload"
    await call("Page.reload")
    await until(() => evaluate('Boolean(document.querySelector("[data-ps-workspace]"))'), "PACKAGED_RELOAD_UNAVAILABLE")
    await until(
      () => evaluate('document.body.innerText.includes("Recorded synthetic result")'),
      "PACKAGED_CONVERSATION_NOT_RESTORED",
    )
    const persisted = await evaluate(
      "window.api.physicalSystems.snapshot().then(s => ({ experiment: s.experiments?.current, session: s.conversation?.sessionId }))",
    )
    if (
      persisted.experiment?.id !== completed.id ||
      persisted.experiment?.trials.length !== 3 ||
      persisted.session !== attached.sessionId
    )
      throw new Error("PACKAGED_RELOAD_CHANGED_OWNERSHIP")
    check(
      stage,
      "PASS",
      "Renderer reload preserved the bound conversation and exactly three recorded trials without replay.",
    )
    stage = "native-v2-credential-probe"
    if (installed || linuxInstallation || appImageRuntime) {
      const preference = await evaluate(
        "window.api.getPinchZoomEnabled().then(async before => { await window.api.setPinchZoomEnabled(!before); return { before, saved: await window.api.getPinchZoomEnabled() } })",
      )
      if (typeof preference?.before !== "boolean" || preference.saved !== !preference.before)
        throw new Error("PACKAGED_REINSTALL_STATE_CHANGED")
      preservedPinchZoom = preference.saved
      if (lab) lab.pinchZoom = preference.saved
      else mainPreservedPinchZoom = preference.saved
    }
    state.sessionId = attached.sessionId
    state.experimentId = completed.id
    await probe.save(v2Request)
    state.saved = await probe.inspectFiles(profile, { databaseName: agentDatabaseName })
    if (lab) lab.after = { state: await preservedState(), vaultSha256: state.saved.vaultSha256 }
    state.backend = await until(
      () => {
        try {
          return backend.result()
        } catch {
          return undefined
        }
      },
      "CREDENTIAL_PROBE_BACKEND_UNCONFIRMED",
      2500,
    )
  } catch (error) {
    if (stage === "launch") {
      const phase = startup.startupPhase()
      if (phase)
        check(
          "startup-phase",
          "NOT_TESTED",
          `Last observed fixed main-process checkpoint: ${phase}. This does not establish application readiness.`,
        )
      const lines =
        process.platform === "linux"
          ? await Promise.all(
              [child.pid, ...(await descendants(child.pid).catch(() => []))].map((pid) =>
                readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
              ),
            )
          : []
      check(
        "startup-observation",
        "NOT_TESTED",
        await startupCheckpointDetail(profile, lines).catch(() => "Startup observations unavailable."),
      )
    }
    if (stage === "native-v2-credential-probe") {
      const transport = credentialTransportObservation.snapshot()
      check(
        "native-v2-credential-observation",
        "NOT_TESTED",
        JSON.stringify({
          save: probe.saveCheckpoint(),
          integration: probe.integrationCheckpoint(),
          readiness: credentialReadiness?.checkpoint(),
          removalReadiness: removalReadiness?.checkpoint(),
          transport,
          credentialRequests: provider.calls.filter((call) => call.credential === true).length,
          otherFixtureRequests: provider.calls.filter((call) => call.credential !== true).length,
          nonceObserved: probe.observationReady(),
          sessionActive: v2Request
            ? await v2Idle().then(
                (idle) => !idle,
                () => null,
              )
            : null,
        }),
      )
    }
    if (stage === "synthetic-chat" || stage === "inline-approval") {
      try {
        const observed = evaluate
          ? await evaluate(`window.api.physicalSystems.snapshot().then(s => {
        const expected = ${JSON.stringify(expectedSynthetic ?? null)};
        const current = s.experiments?.current;
        const trials = Array.isArray(current?.trials) ? current.trials : [];
        return {
        observed: true, projectSelected: Boolean(s.activeProjectId), conversationBound: Boolean(s.conversation?.sessionId),
        hostUnavailable: Boolean(s.hostUnavailable), experimentError: Boolean(s.experiments?.error),
        phase: current?.phase,
        sameExperiment: Boolean(expected && current?.id === expected.id),
        samePlan: Boolean(expected && current?.planDigest === expected.planDigest),
        trialCount: trials.length,
        completedTrials: trials.filter(t => t.status === "COMPLETED").length,
        failedTrials: trials.filter(t => t.status === "FAILED").length,
        continuationState: s.experiments?.continuation?.status,
        conversationBusy: s.conversation?.busy === true,
        approvalVisible: Boolean(document.querySelector("[data-ps-approve]")),
        approvalDisabled: document.querySelector("[data-ps-approve]")?.disabled === true,
        continuationVisible: Boolean(document.querySelector("[data-ps-continue]")),
        continuationDisabled: document.querySelector("[data-ps-continue]")?.disabled === true,
        userMessages: document.querySelectorAll("[data-component=user-message]").length,
        alerts: document.querySelectorAll("[role=alert]").length,
      }; })`).catch(() => undefined)
          : undefined
        check(
          "synthetic-observation",
          "NOT_TESTED",
          fixtureCheckpointDetail({ calls: provider.calls, renderer: observed }),
        )
      } catch {
        // Capture the failed journey before cleanup stops its experiment;
        // optional observations cannot replace the original failure.
      }
    }
    throw error
  } finally {
    startup.dispose()
    const previous = stage
    stage = "cleanup"
    try {
      if (process.platform === "win32") {
        // Enrich the existing one-time numeric descendant snapshot only. The
        // PID liveness gate below remains unchanged pending native evidence.
        windowsShutdownQuery ||= await windowsAppShutdownNative(process.env, root).catch(() => undefined)
        if (windowsShutdownQuery) {
          shutdownInitial.quiescence = "unconfirmed"
          shutdownInitial = await windowsShutdownQuery({ rootPid: child.pid })
        }
        if (shutdownInitial.quiescence === "unconfirmed") {
          systemMutationUnconfirmed = true
          throw new Error("PACKAGED_SHUTDOWN_DIAGNOSTIC_UNCONFIRMED")
        }
        owned =
          shutdownInitial.snapshot.status === "COMPLETE"
            ? shutdownInitial.snapshot.processes.map((item) => item.pid).filter((pid) => pid !== child.pid)
            : await descendants(child.pid)
      } else owned = await descendants(child.pid)
      if (appImageRuntime && !electronPid) throw new Error("APPIMAGE_RUNTIME_OWNER_UNCONFIRMED")
      if (api) {
        const attachment = JSON.parse(await readFile(join(profile, "desktop", "runtime-attach.json"), "utf8"))
        if (attachment.sessionId) await api(`/session/${attachment.sessionId}/abort`, {})
      }
      if (evaluate) {
        await evaluate(
          `(async () => { const s = await window.api.physicalSystems.snapshot(); if (s.deviceConnectionsEnabled !== false || s.activeCaptures.length || s.activeRuns.length) throw new Error('UNEXPECTED_HARDWARE_OWNER'); for (const owner of s.activeExperiments) await window.api.physicalSystems.command({ type:'experiment.stop', projectId:owner.projectId, conversationId:owner.conversationId, serverId:owner.serverId, sessionId:owner.sessionId, connectionGeneration:owner.connectionGeneration, experimentId:owner.experiment.id }); })()`,
        )
        closeRequest = "requested"
        closeRequestedAt = performance.now()
        await evaluate("window.close()").then(
          () => {
            closeRequest = "resolved"
          },
          () => {
            closeRequest = "unconfirmed"
          },
        )
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 15000)
        void exited.then(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      if (child.exitCode === null && child.signalCode === null) throw new Error("PACKAGED_APP_SHUTDOWN_UNCONFIRMED")
      await until(
        async () =>
          owned.every((pid) => {
            try {
              process.kill(pid, 0)
              return false
            } catch {
              return true
            }
          }),
        "PACKAGED_DESCENDANT_RETAINED",
        10000,
      )
      if (
        await readFile(join(profile, "desktop", "runtime-attach.json")).then(
          () => true,
          () => false,
        )
      )
        throw new Error("PACKAGED_ATTACHMENT_RETAINED")
      if (appImageRuntime) {
        const runtime = await appImageRuntime.afterShutdown({
          applicationExited: true,
          descendantsExited: true,
          runtimeExitCode: child.exitCode,
        })
        appImageRuntimeCleanup = true
        if (credentialPhase === "save")
          check(
            "native-fresh-appimage-probe",
            "PASS",
            JSON.stringify({
              ...runtime,
              sameExecutableAndResourcesFingerprint: true,
              apparmorPrerequisite: "exact-executable-userns-profile",
              stockUbuntuWithoutPrerequisiteTested: false,
            }),
          )
      }
      check(
        stage,
        "PASS",
        "Owned Electron process and observed descendants exited; private terminal attachment was removed.",
      )
    } catch (error) {
      if (appImageRuntime) {
        try {
          const trace = shutdownTrace.snapshot()
          shutdownTrace.close()
          const processes = await linuxShutdown?.observe().catch(() => undefined)
          check(
            "linux-app-shutdown-observation",
            "NOT_TESTED",
            JSON.stringify({
              diagnosticOnly: true,
              closeRequest,
              closeElapsedMs:
                closeRequestedAt === undefined
                  ? null
                  : Math.min(120000, Math.max(0, Math.floor(performance.now() - closeRequestedAt))),
              runtimeChildExit:
                child.exitCode !== null ? "exit-code" : child.signalCode !== null ? "signal" : "not-recorded",
              trace,
              processes: processes ?? {
                diagnosticOnly: true,
                runtime: { captured: false, state: "unreadable" },
                electron: { captured: false, state: "unreadable" },
              },
            }),
          )
        } catch {
          // Optional observations cannot replace the original cleanup failure
          // or skip the controller's pipe and process-reference finalization.
        }
      }
      if (process.platform === "win32") {
        // Failure-only final read has its own bounded, close-aware helper. It
        // cannot grant cleanup, retry a signal, or extend the 10-second gate.
        let final = { snapshot: { status: "UNREADABLE", processes: [] }, quiescence: "not-run" }
        try {
          if (windowsShutdownQuery && shutdownInitial.quiescence === "confirmed") {
            final.quiescence = "unconfirmed"
            final = await windowsShutdownQuery({ rootPid: child.pid, pids: [...new Set([child.pid, ...owned])] })
          }
          const diagnostic = classifyWindowsAppShutdown(
            {
              rootPid: child.pid,
              initial: shutdownInitial.snapshot,
              final: final.snapshot,
              main: { exitCode: child.exitCode, signalCode: child.signalCode },
            },
            { includePrivateRecords: privateShutdownRecipient },
          )
          check(
            "windows-app-shutdown-observation",
            "NOT_TESTED",
            JSON.stringify({
              ...diagnostic.observation,
              initialQueryQuiescence: shutdownInitial.quiescence,
              finalQueryQuiescence: final.quiescence,
            }),
          )
          if (privateShutdownRecipient && diagnostic.privateRecords?.length)
            windowsShutdownPrivate = {
              sourceRevision: embeddedInputs?.source?.revision,
              artifactSha256,
              records: diagnostic.privateRecords,
            }
        } catch {
          // An optional diagnostic cannot replace the original cleanup failure
          // or interrupt the controller's pipe/provider/log finalization.
          check(
            "windows-app-shutdown-observation",
            "NOT_TESTED",
            JSON.stringify({
              diagnosticOnly: true,
              initialSnapshot: "UNREADABLE",
              finalSnapshot: "UNREADABLE",
              initialQueryQuiescence: shutdownInitial.quiescence,
              finalQueryQuiescence: final.quiescence,
            }),
          )
        } finally {
          if (shutdownInitial.quiescence === "unconfirmed" || final.quiescence === "unconfirmed")
            systemMutationUnconfirmed = true
        }
      }
      check(
        stage,
        "FAIL",
        "Owned app cleanup is unconfirmed; no retained operation was force-terminated.",
        qualificationFailureCode(error),
      )
      failed ||= error
      child.stdout.unpipe(stdoutFilter)
      child.stderr.unpipe(stderrFilter)
      stdoutFilter.end()
      stderrFilter.end()
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
    }
    try {
      shutdownTrace.close()
    } catch {
      /* Diagnostic listeners never gate cleanup. */
    }
    backend.dispose()
    socket?.close()
    await provider.close()
    diagnosticLogStatus = await privateLog.finish()
    stage = previous
  }
}

// This lab is deliberately separate from the target's already-tested profile.
// Same-source lower-version packages exercise installation/storage preservation,
// without claiming historical schema migration or a physical power interruption.
async function qualifyPublicUpgrade(entrypoint, extension) {
  const format = extension === ".exe" ? "nsis" : extension === ".deb" ? "deb" : "appimage"
  const baselineArtifact = publicUpgrade.baselineArtifact
  if (extname(baselineArtifact).toLowerCase() !== extension) throw new Error("PUBLIC_UPGRADE_FORMAT_INVALID")
  const targetPayload = payload
  const targetState = structuredClone(reinstallBefore)
  const targetVault = (await credentialProbe.inspectFiles(join(root, "profile"), { databaseName: agentDatabaseName }))
    .vaultSha256
  const targetAsar = join(root, "upgrade-target-reference.asar")
  if (format === "nsis")
    await copyFile(join(dirname(entrypoint), "resources/app.asar"), targetAsar, constants.COPYFILE_EXCL)
  const targetReference =
    format === "nsis"
      ? { file: targetAsar, bytes: (await lstat(targetAsar)).size, sha256: await sha256File(targetAsar) }
      : undefined
  const targetMode = publicMode
  const lab = {
    profile: join(root, "upgrade-lab-profile"),
    probe: createNativeV2CredentialProbe({ providerID: "openai" }),
    state: { pids: [] },
    checks: [],
    payload: undefined,
    pinchZoom: undefined,
    after: undefined,
  }
  await mkdir(lab.profile, { mode: 0o700 })
  const closed = () => !failed && checks.find((item) => item.id === "cleanup")?.status === "PASS"
  const shutdown = () => ({
    applicationExited: closed(),
    descendantsExited: closed(),
    runtimeCacheRemoved: format !== "appimage" || appImageRuntimeCleanup,
  })
  const requireClosed = () => {
    if (!closed() || (format === "appimage" && !appImageRuntimeCleanup))
      throw new Error("PUBLIC_UPGRADE_SHUTDOWN_UNCONFIRMED")
  }
  const readVersion = async (executable, mode) => {
    const archive = openPackagedArchive(
      join(repo, "packages/desktop/package.json"),
      join(dirname(executable), "resources/app.asar"),
    )
    verifyPublicPackagedIdentity(mode, {
      metadata: archive.json("package.json"),
      releaseInputs: archive.json("out/legal/desktop-release-inputs.json"),
      publicInputs: archive.json("out/legal/public-build-inputs.json"),
      compiledIdentity: archive.json("out/legal/physical-build-identity.json"),
      mainBytes: archive.read("out/main/index.js"),
    })
    return { version: mode.build.version, executableAndResourcesSha256: (await payloadFingerprint(executable)).sha256 }
  }
  let baselinePayload
  let baselineSignature
  let baselineExecutable
  const installerObservation = format === "nsis" ? await signatureObservation(baselineArtifact) : undefined
  if (installerObservation) verifyPublicAuthenticode(installerObservation, publicUpgrade.baseline.build.windowsSigning)
  const removeInstalled = async () => {
    requireClosed()
    if (installed) {
      await uninstallNsis(installed)
      await verifyNsisRemoved(installed)
      installed = undefined
    } else if (linuxInstallation) {
      const plan = linuxInstallation
      await uninstallDebian(plan)
      await verifyDebianRemoved(plan)
      linuxInstallation = undefined
    }
  }
  const rebindPortable = async (expectedSha256) => {
    requireClosed()
    upgradeInstallationState.unconfirmed = true
    if (!linuxSandboxProfile || (await readFile(linuxSandboxProfile.file, "utf8")) !== linuxSandboxProfile.text)
      throw new Error("PUBLIC_UPGRADE_BASELINE_UNCONFIRMED")
    await command("/usr/bin/sudo", [
      "-n",
      "/usr/sbin/apparmor_parser",
      "--remove",
      "--skip-cache",
      linuxSandboxProfile.file,
    ]).catch(retainUnconfirmedMutation)
    if (profileIsLoaded(await loadedProfiles(), linuxSandboxProfile.name))
      throw new Error("LINUX_QUALIFICATION_PROFILE_RETAINED")
    await unlink(linuxSandboxProfile.file)
    linuxSandboxProfile = undefined
    const next = await prepareAppImageRuntime({
      env: process.env,
      root,
      temporary: linuxTemporary.path,
      artifact: join(root, "extractable.AppImage"),
      artifactSha256: expectedSha256,
      kind: "public",
    })
    await writeFile(next.profile.file, next.profile.text, { flag: "wx", mode: 0o600 })
    linuxSandboxProfile = next.profile
    await command("/usr/bin/sudo", [
      "-n",
      "/usr/sbin/apparmor_parser",
      "--add",
      "--skip-cache",
      next.profile.file,
    ]).catch(retainUnconfirmedMutation)
    if (!profileIsLoaded(await loadedProfiles(), next.profile.name))
      throw new Error("LINUX_QUALIFICATION_PROFILE_NOT_LOADED")
    appImageRuntime = next
  }
  const nativeInstall = async (artifact, hash, version, action = "install") => {
    const result = await runNativeUpgradeInstaller({
      env: process.env,
      root,
      format,
      action,
      artifact,
      artifactSha256: hash,
      version,
      installation: format === "nsis" ? join(root, "payload") : `/opt/${identity.productName}`,
      baselinePayloadSha256: baselinePayload?.sha256 || targetPayload.sha256,
      targetPayloadSha256: targetPayload.sha256,
      targetAsarReference: targetReference,
      descendants,
    })
    if (action === "install") {
      if (format === "nsis") {
        installed = join(root, "payload")
        nsisUninstallerSha256 = await sha256File(await ownedNsisUninstaller(installed))
      } else {
        requireDebianUpgradeStatus(await readFile("/var/lib/dpkg/status", "utf8"), version, "installed")
        const metadata = await command("dpkg-deb", [
          "--show",
          "--showformat=${Package}\n${Version}\n${Architecture}\n",
          artifact,
        ])
        linuxInstallation = debianCandidatePlan(version, metadata, "public")
        if (!debianProfileIsLoaded(await loadedProfiles(), "public"))
          throw new Error("LINUX_QUALIFICATION_PROFILE_NOT_LOADED")
      }
    }
    return result
  }
  const restoreBaseline = async () => {
    requireClosed()
    upgradeInstallationState.unconfirmed = true
    if (format === "appimage") {
      const replace = await prepareAppImageReplacement({
        env: process.env,
        root,
        runnable: appImageRuntime.artifact,
        baselineSha256: artifactSha256,
        targetArtifact: baselineArtifact,
        targetSha256: publicUpgrade.baselineArtifactSha256,
      })
      await replace.complete(shutdown())
      await rebindPortable(publicUpgrade.baselineArtifactSha256)
      if (!baselineExecutable) {
        const extraction = join(root, "upgrade-baseline-extracted")
        await mkdir(extraction, { mode: 0o700 })
        await command(appImageRuntime.artifact, ["--appimage-extract"], { cwd: extraction })
        const matches = await findExecutable(extraction, identity.executableName)
        if (matches.length !== 1) throw new Error("PACKAGED_EXECUTABLE_NOT_UNIQUE")
        baselineExecutable = matches[0]
        await verifyAppImageLauncher(
          dirname(baselineExecutable),
          join(repo, "packages/desktop/resources", identity.launcherSource),
          "public",
        )
      }
    } else {
      await removeInstalled()
      await nativeInstall(baselineArtifact, publicUpgrade.baselineArtifactSha256, publicUpgrade.plan.baseline.version)
      baselineExecutable = entrypoint
    }
    await readVersion(baselineExecutable, publicUpgrade.baseline)
    const observed = await payloadFingerprint(baselineExecutable)
    if (baselinePayload && baselinePayload.sha256 !== observed.sha256)
      throw new Error("PUBLIC_UPGRADE_BASELINE_UNCONFIRMED")
    baselinePayload = observed
    if (format === "nsis")
      baselineSignature = verifyPublicSignaturePair({
        installer: installerObservation,
        executable: await signatureObservation(baselineExecutable),
        mode: publicUpgrade.baseline,
        installerSha256: publicUpgrade.baselineArtifactSha256,
        executableSha256: baselinePayload.executableSha256,
      })
    lab.payload = baselinePayload
    upgradeInstallationState.unconfirmed = false
  }
  const runLab = async (phase, mode) => {
    lab.checks = []
    lab.payload = mode === publicUpgrade.baseline ? baselinePayload : targetPayload
    try {
      await launch(entrypoint, phase, lab)
    } finally {
      const cleanup = lab.checks.find((item) => item.id === "cleanup")
      if (cleanup) check("cleanup", cleanup.status, cleanup.detail, cleanup.failureCode)
      else
        check(
          "cleanup",
          "FAIL",
          "The lab application did not establish shutdown.",
          "PUBLIC_UPGRADE_SHUTDOWN_UNCONFIRMED",
        )
    }
    requireClosed()
    const observation =
      format === "appimage"
        ? { version: mode.build.version, executableAndResourcesSha256: lab.payload.sha256 }
        : await readVersion(entrypoint, mode)
    return { ...observation, ...lab.after, applicationExited: true, descendantsExited: true }
  }
  let seeded
  for (const mode of ["upgrade", "recovery"]) {
    const id = mode === "upgrade" ? "native-upgrade-probe" : "native-failed-upgrade-recovery-probe"
    stage = id
    await restoreBaseline()
    const before = await runLab(seeded ? "upgrade-read" : "save", publicUpgrade.baseline)
    if (
      seeded &&
      (JSON.stringify(before.state) !== JSON.stringify(seeded.state) || before.vaultSha256 !== seeded.vaultSha256)
    )
      throw new Error("PUBLIC_UPGRADE_STATE_CHANGED")
    seeded ||= structuredClone(before)
    const replacement =
      format === "appimage"
        ? await prepareAppImageReplacement({
            env: process.env,
            root,
            runnable: appImageRuntime.artifact,
            baselineSha256: publicUpgrade.baselineArtifactSha256,
            targetArtifact: options.artifact,
            targetSha256: artifactSha256,
          })
        : undefined
    stage = id
    const result = await qualifyInstalledUpgrade({
      env: process.env,
      root,
      format,
      mode,
      plan: publicUpgrade.plan,
      expectedPlanSha256: publicUpgrade.planSha256,
      builds: publicUpgrade.builds,
      signatures: format === "nsis" ? { baseline: baselineSignature, target: publicSigning } : undefined,
      baselineArtifact,
      baselineArtifactSha256: publicUpgrade.baselineArtifactSha256,
      targetArtifact: options.artifact,
      targetArtifactSha256: artifactSha256,
      targetPayloadSha256: targetPayload.sha256,
      before,
      shutdown: shutdown(),
      installationState: upgradeInstallationState,
      observeInstalled: async () => {
        if (format === "appimage") {
          const current = await sha256File(appImageRuntime.artifact)
          if (current === publicUpgrade.baselineArtifactSha256)
            return {
              version: publicUpgrade.plan.baseline.version,
              executableAndResourcesSha256: baselinePayload.sha256,
            }
          if (current === artifactSha256)
            return { version: options.version, executableAndResourcesSha256: targetPayload.sha256 }
          throw new Error("PUBLIC_UPGRADE_TARGET_UNCONFIRMED")
        }
        const archive = openPackagedArchive(
          join(repo, "packages/desktop/package.json"),
          join(dirname(entrypoint), "resources/app.asar"),
        )
        const current = archive.json("package.json").version
        return readVersion(
          entrypoint,
          current === publicUpgrade.plan.baseline.version ? publicUpgrade.baseline : targetMode,
        )
      },
      installTarget: async () => {
        if (replacement) {
          await replacement.complete(shutdown())
          await rebindPortable(artifactSha256)
        } else await nativeInstall(options.artifact, artifactSha256, options.version)
      },
      interruptTarget: () =>
        replacement
          ? replacement.interrupt(shutdown())
          : nativeInstall(options.artifact, artifactSha256, options.version, "interrupt"),
      relaunchBaseline: () => runLab("upgrade-read", publicUpgrade.baseline),
      relaunchTarget: () => runLab("upgrade-read", targetMode),
    })
    // Reopen the original target profile read-only after each independent lab
    // sequence; no model dispatch, trial or preference mutation is repeated.
    await launch(entrypoint, "reinstall")
    requireClosed()
    if (
      JSON.stringify(reinstallAfter) !== JSON.stringify(targetState) ||
      (await credentialProbe.inspectFiles(join(root, "profile"), { databaseName: agentDatabaseName })).vaultSha256 !==
        targetVault
    )
      throw new Error("PUBLIC_UPGRADE_STATE_CHANGED")
    stage = id
    check(
      id,
      "PASS",
      JSON.stringify({
        ...result,
        baselineProfileInitiallyEmpty: true,
        baselineProfileSeededOnce: true,
        originalTargetProfilePreserved: true,
      }),
    )
  }
}

async function ownedNsisUninstaller(directory) {
  if (directory !== join(root, "payload")) throw new Error("PACKAGED_REINSTALL_PATH_INVALID")
  const names = (await readdir(directory)).filter((name) => /^Uninstall .*\.exe$/i.test(name))
  if (names.length !== 1) throw new Error("UNINSTALLER_MISSING")
  return join(directory, names[0])
}

async function uninstallNsis(directory) {
  await requireDisposablePublicRunner(process.env, root)
  const source = await ownedNsisUninstaller(directory)
  if ((await sha256File(source)) !== nsisUninstallerSha256) throw new Error("PACKAGED_REINSTALL_PAYLOAD_CHANGED")
  // NSIS's default /S copies/forks its uninstaller. An exact private copy and
  // final unquoted _?= keep the actual uninstall in the process we await.
  const executable = await executableArtifactCopy(
    source,
    join(root, `owned-uninstaller-${++nsisUninstallCopies}.exe`),
    nsisUninstallerSha256,
  )
  const plan = nsisUninstallArguments(directory)
  systemMutationUnconfirmed = true
  await command(executable, plan.args, nsisSpawnOptions(executable)).catch(retainUnconfirmedMutation)
}

async function verifyNsisRemoved(directory) {
  await until(async () => !(await exists(directory)), "OWNED_UNINSTALL_NOT_COMPLETE", 30000)
  systemMutationUnconfirmed = false
}

async function uninstallDebian(plan) {
  systemMutationUnconfirmed = true
  await command("/usr/bin/sudo", ["-n", "/usr/bin/dpkg", "--purge", plan.packageName]).catch(retainUnconfirmedMutation)
}

async function verifyDebianRemoved(plan) {
  requireAbsentDebianCandidate(await readFile("/var/lib/dpkg/status", "utf8"), identity.kind)
  if (debianProfileIsLoaded(await loadedProfiles(), identity.kind))
    throw new Error("LINUX_QUALIFICATION_PROFILE_RETAINED")
  for (const path of plan.paths) if (await exists(path)) throw new Error("OWNED_UNINSTALL_NOT_COMPLETE")
  systemMutationUnconfirmed = false
}

async function exists(path) {
  return lstat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
}

async function loadedProfiles() {
  return command("/usr/bin/sudo", ["-n", "/bin/cat", "/sys/kernel/security/apparmor/profiles"])
}

function retainUnconfirmedMutation(error) {
  // A timed-out sudo wrapper may leave a child completing installation/policy
  // work. Never race it with an inverse mutation; the disposable job fails.
  if (error?.message === "QUALIFICATION_COMMAND_TIMEOUT") systemMutationUnconfirmed = true
  throw error
}

async function descendants(pid) {
  const rows =
    process.platform === "win32"
      ? JSON.parse(
          await command("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
          ]),
        ).map((row) => ({ pid: row.ProcessId, parent: row.ParentProcessId }))
      : (await command("/bin/ps", ["-eo", "pid=,ppid="]))
          .trim()
          .split("\n")
          .map((line) => {
            const [pid, parent] = line.trim().split(/\s+/).map(Number)
            return { pid, parent }
          })
  const ids = new Set([pid])
  for (let count = -1; count !== ids.size; ) {
    count = ids.size
    for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid)
  }
  ids.delete(pid)
  return [...ids]
}
