// SPDX-License-Identifier: Apache-2.0
// Tests the executable extracted from the named installer, never a separate build.
// Profiles, raw logs and private attachment files stay outside repository/artifacts.
import { mkdtemp, mkdir, readFile, readdir, writeFile, lstat, realpath } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { qualificationPrompt, startFixtureProvider } from "./fixture-provider.mjs"
import { composerReadiness, composerSelection } from "../src/release/composer-readiness.ts"
import { probePackagedRenderer } from "../src/release/cdp-discovery.ts"
import { allocateLinuxQualificationTemporary } from "../src/release/linux-temporary.ts"
import { openPackagedArchive } from "../src/release/packaged-archive.ts"
import { fixtureCheckpointDetail } from "../src/release/fixture-checkpoint.ts"
import { observePrivateLog, startupCheckpointDetail } from "../src/release/startup-observation.ts"
import { sealDiagnostics } from "../src/release/sealed-diagnostics.ts"
import { desktopIdentity } from "../src/release/identity.ts"
import {
  packagedQualificationArguments,
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
  appImageSandboxProfile,
  debianCandidatePlan,
  debianProfileIsLoaded,
  profileIsLoaded,
  requireAbsentDebianCandidate,
  requireDisposableLinuxRunner,
  verifyLinuxRendererSandbox,
} from "../src/release/linux-qualification.ts"

const options = packagedQualificationArguments(process.argv.slice(2))
const publicMode = await loadPublicQualification(options)
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
let linuxInstallation
let linuxSandboxProfile
let linuxTemporary
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
      await command(options.artifact, ["/S", `/D=${extracted}`])
      installed = extracted
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
          const profile = appImageSandboxProfile(executable, root, identity.kind)
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
          entrypoint = join(dirname(executable), "AppRun")
          check(
            stage,
            "PASS",
            "Disposable-runner setup grants user namespaces only to this extracted AppImage executable. This tests the owned AppRun with Chromium sandboxing; default Ubuntu AppImage startup without this prerequisite is not qualified.",
          )
        }
      }
      await launch(entrypoint)
    }
  }
} catch (error) {
  failed = error
  // Fixed diagnostic codes only; raw app output and provider credentials never enter receipts.
  check(
    stage,
    "FAIL",
    "Qualification failed at this boundary; inspect the private CI diagnostic log.",
    qualificationFailureCode(error),
  )
  await writeFile(join(root, "diagnostic.txt"), String(error?.stack || error), { mode: 0o600 })
} finally {
  const safeToRemove =
    !systemMutationUnconfirmed &&
    (!applicationStarted || checks.find((item) => item.id === "cleanup")?.status === "PASS")
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
        await command("/usr/bin/sudo", ["-n", "/usr/bin/dpkg", "--purge", linuxInstallation.packageName])
        requireAbsentDebianCandidate(await readFile("/var/lib/dpkg/status", "utf8"), identity.kind)
        if (debianProfileIsLoaded(await loadedProfiles(), identity.kind))
          throw new Error("LINUX_QUALIFICATION_PROFILE_RETAINED")
        for (const path of linuxInstallation.paths)
          if (await exists(path)) throw new Error("OWNED_UNINSTALL_NOT_COMPLETE")
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
      const uninstallers = (await readdir(installed)).filter((name) => /^Uninstall .*\.exe$/i.test(name))
      if (uninstallers.length === 1) {
        try {
          await command(join(installed, uninstallers[0]), ["/S"])
          await until(
            () =>
              lstat(join(installed, `${identity.productName}.exe`)).then(
                () => false,
                () => true,
              ),
            "OWNED_UNINSTALL_NOT_COMPLETE",
            30000,
          )
          check(
            "uninstall",
            "PASS",
            "Owned per-user package uninstalled after confirming that no application was started or application shutdown completed.",
          )
        } catch (error) {
          check(
            "uninstall",
            "FAIL",
            "Package uninstallation did not confirm completion.",
            qualificationFailureCode(error),
          )
          failed ||= new Error("UNINSTALL_UNCONFIRMED")
        }
      } else {
        check("uninstall", "FAIL", "Expected owned NSIS uninstaller was not found.", "UNINSTALLER_MISSING")
        failed ||= new Error("UNINSTALLER_MISSING")
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

async function launch(executable) {
  stage = "launch"
  const profile = join(root, "profile")
  if (process.platform === "linux") linuxTemporary = await allocateLinuxQualificationTemporary(process.env, root)
  for (const folder of ["config/opencode", "tmp", "empty-path", "appdata", "localappdata"])
    await mkdir(join(profile, folder), { recursive: true, mode: 0o700 })
  const provider = await startFixtureProvider()
  await writeFile(
    join(profile, "config", "opencode", "opencode.json"),
    JSON.stringify({
      model: "fixture/fixture",
      small_model: "fixture/fixture",
      enabled_providers: ["fixture"],
      provider: {
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
  const child = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${join(profile, "desktop")}`,
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
    ],
    {
      cwd: profile,
      env: { ...qualificationEnvironment(process.env, profile), ...linuxTemporary?.environment },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  applicationStarted = true
  const log = createWriteStream(join(root, "application.log"), { mode: 0o600 })
  const privateLog = observePrivateLog(log)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const exited = new Promise((resolve) => {
    child.once("exit", resolve)
    child.once("error", resolve)
  })
  const startup = observePackagedStartup(child)
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
      "Installed/extracted Electron payload loaded the actual renderer with no Node or Bun on its PATH.",
    )
    stage = "device-isolation"
    const safety = await evaluate(
      "window.api.physicalSystems.snapshot().then(s => ({ enabled: s.deviceConnectionsEnabled, projects: s.projects.length, captures: s.activeCaptures.length, runs: s.activeRuns.length }))",
    )
    if (safety.enabled !== false || safety.projects !== 0 || safety.captures !== 0 || safety.runs !== 0)
      throw new Error("PACKAGED_PROFILE_NOT_ISOLATED")
    check(
      stage,
      "PASS",
      "Fresh private profile reports device connections disabled, no projects and no owned hardware operations.",
    )
    stage = "synthetic-chat"
    await click('[aria-label="New project"]')
    await until(
      () => evaluate('Boolean(document.querySelector("dialog[open] input"))'),
      "PACKAGED_PROJECT_DIALOG_UNAVAILABLE",
    )
    await type("dialog[open] input", "Packaged synthetic qualification")
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
    check(
      stage,
      "PASS",
      "Real bundled agent loop used the inert local provider to propose exactly a synthetic experiment; no trial ran before approval.",
    )
    const attached = JSON.parse(await readFile(join(profile, "desktop", "runtime-attach.json"), "utf8"))
    if (attached.pid !== child.pid || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(attached.url))
      throw new Error("PACKAGED_ATTACHMENT_OWNER_INVALID")
    api = async (path, body) =>
      fetch(`${attached.url}${path}?directory=${encodeURIComponent(attached.directory)}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${attached.username}:${attached.password}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(6000),
      })
    stage = "inline-approval"
    await until(
      () => evaluate('document.querySelector(".ps-experiment input[type=checkbox]")?.disabled === false'),
      "PACKAGED_APPROVAL_NOT_READY",
    )
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
    if (stage === "synthetic-chat") {
      const observed = evaluate
        ? await evaluate(`window.api.physicalSystems.snapshot().then(s => ({
        observed: true, projectSelected: Boolean(s.activeProjectId), conversationBound: Boolean(s.conversation?.sessionId),
        hostUnavailable: Boolean(s.hostUnavailable), experimentError: Boolean(s.experiments?.error),
        phase: s.experiments?.current?.phase,
        approvalVisible: Boolean(document.querySelector("[data-ps-approve]")),
        userMessages: document.querySelectorAll("[data-component=user-message]").length,
        alerts: document.querySelectorAll("[role=alert]").length,
      }))`).catch(() => undefined)
        : undefined
      check(
        "synthetic-observation",
        "NOT_TESTED",
        fixtureCheckpointDetail({ calls: provider.calls, renderer: observed }),
      )
    }
    throw error
  } finally {
    startup.dispose()
    const previous = stage
    stage = "cleanup"
    try {
      owned = await descendants(child.pid)
      if (api) {
        const attachment = JSON.parse(await readFile(join(profile, "desktop", "runtime-attach.json"), "utf8"))
        if (attachment.sessionId) await api(`/session/${attachment.sessionId}/abort`, {})
      }
      if (evaluate) {
        await evaluate(
          `(async () => { const s = await window.api.physicalSystems.snapshot(); if (s.deviceConnectionsEnabled !== false || s.activeCaptures.length || s.activeRuns.length) throw new Error('UNEXPECTED_HARDWARE_OWNER'); for (const owner of s.activeExperiments) await window.api.physicalSystems.command({ type:'experiment.stop', projectId:owner.projectId, conversationId:owner.conversationId, serverId:owner.serverId, sessionId:owner.sessionId, connectionGeneration:owner.connectionGeneration, experimentId:owner.experiment.id }); })()`,
        )
        await evaluate("window.close()").catch(() => {})
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
      check(
        stage,
        "PASS",
        "Owned Electron process and observed descendants exited; private terminal attachment was removed.",
      )
    } catch (error) {
      check(
        stage,
        "FAIL",
        "Owned app cleanup is unconfirmed; no retained operation was force-terminated.",
        qualificationFailureCode(error),
      )
      failed ||= error
      child.stdout.unpipe(log)
      child.stderr.unpipe(log)
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
    }
    socket?.close()
    await provider.close()
    diagnosticLogStatus = await privateLog.finish()
    stage = previous
  }
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
