// SPDX-License-Identifier: Apache-2.0
// Disposable runner test of the actual titlebar button and production updater.
// There is no feed override, installer mock, silent update or manual target launch.
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { openPackagedArchive } from "../src/release/packaged-archive.ts"
import { requireDisposablePublicRunner, verifyPublicPackagedIdentity } from "../src/release/public-qualification.ts"
import { releaseInputDigest, compareVersion } from "../src/release/inputs.ts"
import { validatePublicBuildInputs, verifyCompiledPublicIdentity } from "../src/release/public-build.ts"
import { publicReviewDigest } from "../src/release/public-downloads.ts"
import { sha256File, payloadFingerprint } from "../src/release/qualification.ts"
import { nsisInstallArguments, nsisSpawnOptions } from "../src/release/installed-reinstall.ts"
import { inspectPreviewUpdateInstallation } from "../../desktop/src/main/preview-update-install.ts"
import {
  createPreviewUpdateWindowsNative,
  previewUpdateWindowsTime,
  readPreviewUpdateWindowsObservation,
} from "../src/release/preview-update-windows.ts"
import {
  clickPreviewUpdateLinuxConfirmation,
  startPreviewUpdatePolkitAgent,
  PreviewUpdateLinuxError,
} from "../src/release/preview-update-linux.ts"

const root = resolve(process.argv[3] || ".")
if (process.argv.length !== 4 || process.argv[2] !== "--root") throw Error("PREVIEW_UPDATE_ARGUMENTS_INVALID")
await requireDisposablePublicRunner(process.env, root)
if (
  process.env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  process.env.PHYSICALSYSTEMS_UPDATER_TEST !== "1" ||
  process.env.RUNNER_ARCH !== "X64" ||
  process.arch !== "x64"
)
  throw Error("PREVIEW_UPDATE_DISPOSABLE_TEST_REQUIRED")
const windows = process.platform === "win32"
const platform = windows ? "windows-x64" : "linux-x64"
const marker = await privateJson(join(root, "preview-update-runner.json"))
if (marker.kind !== "disposable-preview-update" || marker.runId !== process.env.GITHUB_RUN_ID)
  throw Error("PREVIEW_UPDATE_OWNER_MISMATCH")
const plan = await privateJson(join(root, "plan.json"))
const build = await privateJson(join(root, "build-record.json"))
if (
  !/^[a-f0-9]{64}$/.test(process.env.UPDATER_TEST_PLAN_SHA256 || "") ||
  publicReviewDigest(plan) !== process.env.UPDATER_TEST_PLAN_SHA256 ||
  plan.kind !== "unpublished-preview-updater-test" ||
  plan.publication !== false ||
  plan.qualification !== false ||
  plan.sourceRevision !== process.env.GITHUB_SHA ||
  plan.version !== "0.1.0-beta.1" ||
  plan.platform !== platform ||
  build.kind !== "unpublished-preview-updater-test-build" ||
  build.sourceRevision !== plan.sourceRevision ||
  build.version !== plan.version ||
  build.platform !== platform ||
  build.publication !== false ||
  build.qualification !== false ||
  build.releaseInputsSha256 !== plan.releaseInputsSha256 ||
  build.publicBuildInputsSha256 !== plan.publicBuildInputsSha256 ||
  plan.target?.status !== "available" ||
  plan.target.channel !== "preview" ||
  !plan.target.unsignedWindowsPreview
)
  throw Error("PREVIEW_UPDATE_PLAN_MISMATCH")
const asset = plan.target.assets.find((item) => item.name.endsWith(windows ? "-windows-x64.exe" : "-linux-x64.deb"))
if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error("PREVIEW_UPDATE_TARGET_INVALID")
if (
  build.installer.path !== join(root, "build", build.installer.name) ||
  basename(build.installer.name) !== build.installer.name
)
  throw Error("PREVIEW_UPDATE_INSTALLER_PATH_INVALID")
await verifyFile(build.installer.path, build.installer)
const acknowledgement = plan.startupAcknowledgement
const acknowledgementBuild = build.startupAcknowledgement
if (
  !acknowledgement ||
  !acknowledgementBuild ||
  compareVersion(acknowledgement.version, plan.target.version) <= 0 ||
  ["version", "releaseInputsSha256", "publicBuildInputsSha256"].some(
    (key) => acknowledgement[key] !== acknowledgementBuild[key],
  ) ||
  acknowledgementBuild.installer.path !== join(root, "ack-build", acknowledgementBuild.installer.name) ||
  basename(acknowledgementBuild.installer.name) !== acknowledgementBuild.installer.name
)
  throw Error("PREVIEW_UPDATE_ACKNOWLEDGEMENT_PLAN_MISMATCH")
await verifyFile(acknowledgementBuild.installer.path, acknowledgementBuild.installer)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const profile = join(
  windows ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "physicalsystems-desktop",
)
if (process.env.PHYSICALSYSTEMS_DATA_DIR || (await exists(profile)))
  throw Error("PREVIEW_UPDATE_FRESH_DEFAULT_PROFILE_REQUIRED")
const receipt = {
  schemaVersion: 1,
  kind: "disposable-preview-update-result",
  publication: false,
  releaseQualification: false,
  sourceRevision: plan.sourceRevision,
  platform,
  from: plan.version,
  to: plan.target.version,
  baselineInstallerSha256: build.installer.sha256,
  targetInstallerSha256: asset.sha256,
  status: "RUNNING",
  stages: [],
  limitations: [
    "Startup acknowledgement is tested after a separate manual fixture installation, not a second updater-driven upgrade.",
    "Native interrupted-installation recovery is not exercised.",
    "Preservation assertion covers a renderer setting; full conversation and credential migration is qualified separately.",
  ],
}
const record = async (name) => {
  receipt.stages.push(name)
  await writeFile(join(root, "result.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 })
  console.log(`Preview updater: ${name}`)
}
let stage = "bootstrap-install"
let baseline
let current
let cdp
let keyring
let polkit
let authUserCreated = false
const native = windows ? await createPreviewUpdateWindowsNative({ env: process.env, root }) : undefined
try {
  await record("test-inputs-and-installer-verified")
  const executable = await bootstrap()
  await verifyPackage(executable, plan.version, true)
  await record("unpublished-baseline-installed")
  stage = "baseline-startup"
  if (!windows) keyring = await startKeyring()
  const launchedAfter = windows ? previewUpdateWindowsTime() : undefined
  const launch = await launchInstalled(executable)
  baseline = launch.child
  const announced = launch.endpoint
  current = windows
    ? await wait(
        () => native.observe({ executable, version: plan.version, after: launchedAfter }),
        60000,
        "BASELINE_WINDOW_UNCONFIRMED",
      )
    : await linuxProcess(baseline.pid, executable)
  if (current.pid !== baseline.pid) throw Error("PREVIEW_UPDATE_BASELINE_PROCESS_MISMATCH")
  cdp = await connectRenderer(new URL(announced).port)
  await wait(
    () => cdp.evaluate("Boolean(window.api?.updater && document.querySelector('[data-action=desktop-update]'))"),
    90000,
    "BASELINE_BUTTON_UNAVAILABLE",
  )
  const available = await cdp.evaluate("window.api.updater.check()")
  if (available.status !== "available" || available.version !== plan.target.version || available.mode !== "preview")
    throw Error("PREVIEW_UPDATE_ACTUAL_DISCOVERY_MISMATCH")
  const nonce = randomBytes(24).toString("hex")
  await cdp.evaluate(`window.api.storeSet('opencode.settings','preview-updater-test',${JSON.stringify(nonce)})`)
  if ((await cdp.evaluate("window.api.storeGet('opencode.settings','preview-updater-test')")) !== nonce)
    throw Error("PREVIEW_UPDATE_BASELINE_SETTING_UNCONFIRMED")
  await record("actual-button-and-official-discovery-confirmed")

  stage = "download-and-later"
  await clickUpdate(cdp)
  await confirm("later")
  const ready = await wait(
    async () => {
      const state = await cdp.evaluate("window.api.updater.check()")
      return state.status === "ready" && state.version === plan.target.version && state
    },
    30000,
    "LATER_DID_NOT_RETAIN_READY_STATE",
  )
  if (!ready || launch.closed() || (await journal())?.attempt) throw Error("PREVIEW_UPDATE_LATER_CHANGED_INSTALLATION")
  await verifyPackage(executable, plan.version, true)
  const cache = join(profile, "desktop", "preview-updates", asset.name)
  await verifyFile(cache, asset)
  await record("real-download-verified-and-native-later-preserved-baseline")

  stage = "native-installation"
  if (!windows) {
    const authPassword = randomBytes(36).toString("base64url")
    const existing = await command("/usr/bin/getent", ["passwd", "ps-update-auth"], { allowFailure: true })
    if (existing.code !== 2) throw Error("PREVIEW_UPDATE_AUTH_ACCOUNT_ALREADY_EXISTS")
    await command("/usr/bin/sudo", [
      "-n",
      "/usr/sbin/useradd",
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      "--groups",
      "sudo",
      "ps-update-auth",
    ])
    authUserCreated = true
    await command("/usr/bin/sudo", ["-n", "/usr/sbin/chpasswd"], { stdin: `ps-update-auth:${authPassword}\n` })
    polkit = await startPreviewUpdatePolkitAgent({
      env: process.env,
      root,
      applicationPid: current.pid,
      version: plan.target.version,
      authUser: "ps-update-auth",
      authPassword,
    })
    await polkit.ready
  }
  const installedAfter = windows ? previewUpdateWindowsTime() : current.birth
  const old = current
  const originalDeparted = windows ? await native.captureShutdown({ application: current }) : undefined
  await clickUpdate(cdp)
  await confirm("install")
  await wait(
    async () => {
      const attempt = (await journal())?.attempt
      return attempt?.from === plan.version && attempt.to === plan.target.version && attempt.sha256 === asset.sha256
    },
    30000,
    "INSTALL_ATTEMPT_NOT_RECORDED",
  )
  if (polkit) {
    await polkit.authenticated
  }
  await wait(
    () => (windows ? native.exited({ application: old }) : Promise.resolve(launch.closed())),
    180000,
    "OLD_APPLICATION_EXIT_UNCONFIRMED",
  )
  if (originalDeparted) await wait(originalDeparted, 60000, "ORIGINAL_DESCENDANT_EXIT_UNCONFIRMED")
  await wait(async () => launch.closed(), 10000, "ORIGINAL_CHILD_EXIT_UNCONFIRMED")
  if (!launch.cleanExit()) throw Error("PREVIEW_UPDATE_BASELINE_EXIT_NOT_SUCCESSFUL")
  if (polkit) {
    // The terminal success message precedes Polkit's final D-Bus reply. Keep
    // its listener alive until the real package manager has finished.
    await verifyPackage(executable, plan.target.version, false)
    await polkit.stop()
    polkit = undefined
  }
  cdp.close()
  cdp = undefined
  await record("native-confirmation-and-old-application-exit-confirmed")

  stage = "actual-target-restart"
  // Only observe the installer/app-owned relaunch. Starting the target here
  // would hide a broken updater restart and is deliberately prohibited.
  current = windows
    ? await wait(
        () => native.observe({ executable, version: plan.target.version, after: installedAfter, previousPid: old.pid }),
        180000,
        "NSIS_TARGET_RESTART_UNCONFIRMED",
      )
    : await wait(() => linuxRestart(executable, old), 180000, "DEBIAN_TARGET_RESTART_UNCONFIRMED")
  await verifyPackage(executable, plan.target.version, false)
  const fingerprint = await payloadFingerprint(executable)
  receipt.observedTargetPayloadSha256 = fingerprint.sha256
  if (!windows) {
    const args = (await readFile(`/proc/${current.pid}/cmdline`, "utf8")).split("\0")
    if (!args.includes("--remote-debugging-port=0")) throw Error("PREVIEW_UPDATE_RELAUNCH_ARGUMENTS_LOST")
    const debug = await wait(
      async () => {
        const values = await Promise.all(
          ["session", "desktop"].map((folder) =>
            readFile(join(profile, folder, "DevToolsActivePort"), "utf8").catch(() => ""),
          ),
        )
        const ports = [
          ...new Set(
            values
              .map((value) => value.split("\n")[0])
              .filter((port) => /^\d{1,5}$/.test(port) && port !== new URL(announced).port),
          ),
        ]
        if (ports.length > 1) throw Error("PREVIEW_UPDATE_TARGET_DEBUG_ENDPOINT_AMBIGUOUS")
        return ports[0]
      },
      90000,
      "TARGET_DEBUG_ENDPOINT_UNCONFIRMED",
    )
    cdp = await connectRenderer(debug)
    await wait(() => cdp.evaluate("Boolean(window.api?.storeGet)"), 90000, "TARGET_RENDERER_UNAVAILABLE")
    if ((await cdp.evaluate("window.api.storeGet('opencode.settings','preview-updater-test')")) !== nonce)
      throw Error("PREVIEW_UPDATE_TARGET_SETTING_UNCONFIRMED")
  }
  const persisted = JSON.parse(await readFile(join(profile, "desktop", "opencode.settings"), "utf8"))
  if (persisted["preview-updater-test"] !== nonce) throw Error("PREVIEW_UPDATE_SETTING_NOT_PRESERVED")
  await record("actual-target-process-package-and-preserved-setting-confirmed")

  stage = "normal-target-close"
  const targetDeparted = windows ? await native.captureShutdown({ application: current }) : undefined
  if (windows) await native.close({ application: current })
  else void cdp.evaluate("window.close(); true").catch(() => {})
  await wait(
    () => (windows ? native.exited({ application: current }) : linuxExited(current)),
    60000,
    "TARGET_NORMAL_CLOSE_UNCONFIRMED",
  )
  if (targetDeparted) await wait(targetDeparted, 60000, "TARGET_DESCENDANT_EXIT_UNCONFIRMED")
  current = undefined
  cdp?.close()
  cdp = undefined
  await record("target-normal-close-confirmed")

  stage = "manual-startup-acknowledgement-install"
  const attempted = (await journal())?.attempt
  if (attempted?.from !== plan.version || attempted.to !== plan.target.version || attempted.sha256 !== asset.sha256)
    throw Error("PREVIEW_UPDATE_REAL_ATTEMPT_NOT_RETAINED")
  await verifyFile(acknowledgementBuild.installer.path, acknowledgementBuild.installer)
  // Separate manual installation exercises acknowledgement by the new code.
  // It is never reported as another successful in-app update or recovery retry.
  if (windows)
    await command(acknowledgementBuild.installer.path, nsisInstallArguments(dirname(executable)).args, {
      spawnOptions: nsisSpawnOptions(acknowledgementBuild.installer.path),
    })
  else
    await command("/usr/bin/sudo", [
      "-n",
      "/usr/bin/dpkg",
      "--refuse-downgrade",
      "--install",
      acknowledgementBuild.installer.path,
    ])
  await verifyPackage(executable, acknowledgement.version, false, acknowledgement)
  if (publicReviewDigest((await journal())?.attempt) !== publicReviewDigest(attempted))
    throw Error("PREVIEW_UPDATE_MANUAL_INSTALL_CHANGED_JOURNAL")
  await record("manual-new-code-install-retained-real-attempt")

  stage = "automatic-startup-acknowledgement"
  const acknowledgementAfter = windows ? previewUpdateWindowsTime() : undefined
  const acknowledgementLaunch = await launchInstalled(executable)
  baseline = acknowledgementLaunch.child
  current = windows
    ? await wait(
        () => native.observe({ executable, version: acknowledgement.version, after: acknowledgementAfter }),
        60000,
        "ACKNOWLEDGEMENT_WINDOW_UNCONFIRMED",
      )
    : await linuxProcess(acknowledgementLaunch.child.pid, executable)
  if (current.pid !== acknowledgementLaunch.child.pid) throw Error("PREVIEW_UPDATE_ACKNOWLEDGEMENT_PROCESS_MISMATCH")
  // No check()/recover() call or journal mutation: index.ts starts the updater.
  await wait(async () => (await journal())?.attempt === undefined, 90000, "STARTUP_DID_NOT_ACKNOWLEDGE_REAL_ATTEMPT")
  cdp = await connectRenderer(new URL(acknowledgementLaunch.endpoint).port)
  await wait(
    () => cdp.evaluate("Boolean(window.api?.storeGet && document.querySelector('[data-action=desktop-update]'))"),
    90000,
    "ACKNOWLEDGEMENT_RENDERER_UNAVAILABLE",
  )
  if ((await cdp.evaluate("window.api.storeGet('opencode.settings','preview-updater-test')")) !== nonce)
    throw Error("PREVIEW_UPDATE_ACKNOWLEDGEMENT_SETTING_LOST")
  await verifyPackage(executable, acknowledgement.version, false, acknowledgement)
  receipt.startupAcknowledgement = {
    version: acknowledgement.version,
    sourceRevision: plan.sourceRevision,
    installerSha256: acknowledgementBuild.installer.sha256,
    result: "PASS",
    installation: "separate-manual-fixture",
  }
  await record("new-code-startup-acknowledged-real-attempt-and-preserved-setting")
  const acknowledgementDeparted = windows ? await native.captureShutdown({ application: current }) : undefined
  if (windows) await native.close({ application: current })
  else void cdp.evaluate("window.close(); true").catch(() => {})
  await wait(
    () => (windows ? native.exited({ application: current }) : linuxExited(current)),
    60000,
    "ACKNOWLEDGEMENT_NORMAL_CLOSE_UNCONFIRMED",
  )
  if (acknowledgementDeparted) await wait(acknowledgementDeparted, 60000, "ACKNOWLEDGEMENT_DESCENDANT_EXIT_UNCONFIRMED")
  await wait(async () => acknowledgementLaunch.closed(), 10000, "ACKNOWLEDGEMENT_CHILD_EXIT_UNCONFIRMED")
  if (!acknowledgementLaunch.cleanExit()) throw Error("PREVIEW_UPDATE_ACKNOWLEDGEMENT_EXIT_NOT_SUCCESSFUL")
  current = undefined
  cdp.close()
  cdp = undefined
  await record("acknowledgement-fixture-normal-close-confirmed")
  if (polkit) await polkit.stop()
  if (authUserCreated) await command("/usr/bin/sudo", ["-n", "/usr/sbin/userdel", "ps-update-auth"])
  authUserCreated = false
  if (keyring) await keyring.stop()
  receipt.status = "PASS"
  await record("test-complete")
} catch (error) {
  receipt.status = "FAIL"
  receipt.failedStage = stage
  receipt.failureCode =
    error instanceof Error && /^[A-Z][A-Z0-9_]{1,120}$/.test(error.message)
      ? error.message
      : "PREVIEW_UPDATE_TEST_UNCONFIRMED"
  if (error instanceof Error && /^PREVIEW_UPDATE_WINDOWS_UNCONFIRMED:[a-z-]{1,30}$/.test(error.message))
    receipt.nativePhase = error.message.split(":")[1]
  if (error instanceof PreviewUpdateLinuxError && error.nativeDialog) receipt.nativeDialog = error.nativeDialog
  const windowsObservation = readPreviewUpdateWindowsObservation(error)
  if (windowsObservation) receipt.nativeWindows = windowsObservation
  await record("test-failed")
  // Uncertain native installation is not killed, retried, or cleaned up as if
  // complete. The isolated hosted VM owns teardown after this failing test.
  cdp?.close()
  await polkit?.stop().catch(() => {})
  baseline?.stderr?.destroy()
  baseline?.unref()
  // Exit the test controller only; hosted runner teardown owns remaining native
  // processes. A timeout must not terminate a possibly active package manager.
  process.exit(1)
}

async function privateJson(file) {
  const stat = await lstat(file)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 2 * 1024 * 1024 ||
    (!windows && (stat.uid !== process.getuid() || stat.mode & 0o077))
  )
    throw Error("PREVIEW_UPDATE_PRIVATE_INPUT_INVALID")
  return JSON.parse(await readFile(file, "utf8"))
}
async function exists(file) {
  return lstat(file).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
}
async function verifyFile(file, expected) {
  const stat = await lstat(file)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size !== expected.bytes ||
    (await sha256File(file)) !== expected.sha256
  )
    throw Error("PREVIEW_UPDATE_FILE_MISMATCH")
}
async function wait(probe, timeout, code) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw Error(`PREVIEW_UPDATE_${code}`)
}
async function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      ...options.spawnOptions,
    })
    let stdout = ""
    let oversized = false
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > 1024 * 1024) {
        oversized = true
        stdout = ""
      }
    })
    child.stderr.resume()
    const timer = setTimeout(() => {
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      reject(Error("PREVIEW_UPDATE_COMMAND_TIMEOUT"))
    }, 180000)
    child.once("error", () => {
      clearTimeout(timer)
      reject(Error("PREVIEW_UPDATE_COMMAND_LAUNCH_FAILED"))
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (oversized || (code !== 0 && !options.allowFailure)) return reject(Error("PREVIEW_UPDATE_COMMAND_FAILED"))
      resolve({ code, stdout })
    })
    child.stdin?.on("error", () => reject(Error("PREVIEW_UPDATE_COMMAND_INPUT_FAILED")))
    child.stdin?.end(options.stdin)
  })
}
async function bootstrap() {
  if (windows) {
    const destination = join(root, "install")
    if (await exists(destination)) throw Error("PREVIEW_UPDATE_FRESH_INSTALL_DIRECTORY_REQUIRED")
    await command(build.installer.path, nsisInstallArguments(destination).args, {
      spawnOptions: nsisSpawnOptions(build.installer.path),
    })
    return realpath(join(destination, "Physical Systems.exe"))
  }
  const absent = await command("/usr/bin/dpkg-query", ["--show", "physical-systems-desktop"], { allowFailure: true })
  if (absent.code !== 1) throw Error("PREVIEW_UPDATE_FRESH_PACKAGE_REQUIRED")
  await command("/usr/bin/sudo", ["-n", "/usr/bin/dpkg", "--install", build.installer.path])
  const files = (await command("/usr/bin/dpkg-query", ["--listfiles", "physical-systems-desktop"])).stdout
    .trim()
    .split("\n")
  const executables = files.filter((file) => file.startsWith("/opt/") && basename(file) === "physical-systems-desktop")
  if (executables.length !== 1) throw Error("PREVIEW_UPDATE_DEBIAN_EXECUTABLE_AMBIGUOUS")
  return realpath(executables[0])
}
async function verifyPackage(executable, version, lab, expected) {
  const installation = await inspectPreviewUpdateInstallation({
    platform: process.platform,
    arch: process.arch,
    executablePath: executable,
    currentVersion: version,
  })
  if (!installation) throw Error("PREVIEW_UPDATE_NATIVE_PACKAGE_UNCONFIRMED")
  const archive = openPackagedArchive(
    join(repo, "packages", "desktop", "package.json"),
    join(dirname(executable), "resources", "app.asar"),
  )
  const manifest = archive.json("package.json")
  const inputs = archive.json("out/legal/desktop-release-inputs.json")
  const publicInputs = archive.json("out/legal/public-build-inputs.json")
  const compiledIdentity = archive.json("out/legal/physical-build-identity.json")
  const mainBytes = archive.read("out/main/index.js")
  if (
    manifest.version !== version ||
    inputs.version !== version ||
    publicInputs.version !== version ||
    publicInputs.identity?.kind !== "public" ||
    publicInputs.identity?.appId !== "systems.physical.desktop" ||
    (lab &&
      (inputs.upgradeLab !== "unreleased-updater-test-only" ||
        publicInputs.updaterTest !== "unreleased-updater-test-only" ||
        inputs.source.revision !== plan.sourceRevision ||
        publicInputs.sourceRevision !== plan.sourceRevision))
  )
    throw Error("PREVIEW_UPDATE_PACKAGED_SOURCE_MISMATCH")
  if (lab) {
    validatePublicBuildInputs(publicInputs, plan.publicBuildInputsSha256, { allowUpdaterTest: true })
    if (
      releaseInputDigest(inputs) !== plan.releaseInputsSha256 ||
      inputs.sha256 !== plan.releaseInputsSha256 ||
      manifest.name !== "physical-systems-desktop"
    )
      throw Error("PREVIEW_UPDATE_PACKAGED_INPUTS_MISMATCH")
    verifyCompiledPublicIdentity(compiledIdentity, plan.publicBuildInputsSha256, mainBytes)
    return
  }
  const publicBuildInputsSha256 = publicReviewDigest(publicInputs)
  verifyPublicPackagedIdentity(
    { build: publicInputs, publicBuildInputsSha256, releaseInputsSha256: inputs.sha256 },
    {
      metadata: manifest,
      releaseInputs: inputs,
      publicInputs,
      compiledIdentity,
      mainBytes,
    },
  )
  if (expected) {
    if (
      publicBuildInputsSha256 !== expected.publicBuildInputsSha256 ||
      inputs.sha256 !== expected.releaseInputsSha256 ||
      publicInputs.sourceRevision !== plan.sourceRevision
    )
      throw Error("PREVIEW_UPDATE_ACKNOWLEDGEMENT_INPUTS_MISMATCH")
    return
  }
  receipt.observedTargetSourceRevision = publicInputs.sourceRevision
  receipt.observedTargetPublicBuildInputsSha256 = publicBuildInputsSha256
}
async function journal() {
  return readFile(join(profile, "desktop", "main", "preview-update"), "utf8").then(JSON.parse, (error) => {
    if (error.code === "ENOENT") return
    throw error
  })
}
async function launchInstalled(executable) {
  let endpoint
  let output = ""
  let closed = false
  let successfulExit = false
  const child = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--disable-gpu",
      ...(!windows ? ["--force-renderer-accessibility"] : []),
    ],
    {
      cwd: root,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        PHYSICALSYSTEMS_ALLOW_DEVICES: "0",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        LANGUAGE: "en",
        NO_AT_BRIDGE: "0",
        GTK_MODULES: "atk-bridge",
        ...(!windows ? { ACCESSIBILITY_ENABLED: "1" } : {}),
      },
    },
  )
  child.once("error", () => {
    closed = true
  })
  child.once("exit", (code, signal) => {
    closed = true
    successfulExit = code === 0 && signal === null
  })
  child.stderr.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-8192)
    const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/.exec(output)
    if (match) endpoint = match[1]
  })
  await wait(
    async () => {
      if (closed) throw Error("PREVIEW_UPDATE_APPLICATION_EXITED_BEFORE_READY")
      return endpoint
    },
    90000,
    "APPLICATION_DEBUG_ENDPOINT_UNCONFIRMED",
  )
  return { child, endpoint, closed: () => closed, cleanExit: () => successfulExit }
}
async function clickUpdate(client) {
  const clicked = await client.evaluate(
    `(() => { const button = document.querySelector('[data-action="desktop-update"]'); if (!button || button.disabled || !button.getBoundingClientRect().width) return false; button.click(); return true })()`,
  )
  if (!clicked) throw Error("PREVIEW_UPDATE_BUTTON_NOT_ACTIONABLE")
}
async function confirm(choice) {
  if (windows)
    return wait(
      async () =>
        (await native.confirm({
          application: current,
          version: plan.target.version,
          action: choice === "later" ? "Later" : "Install update",
        })) === "invoked",
      360000,
      "NATIVE_CONFIRMATION_UNCONFIRMED",
    )
  // install() enters installing before awaiting the real native confirmation.
  await wait(
    async () => {
      const state = await cdp.evaluate("window.api.updater.check()")
      if (["error", "blocked", "disabled"].includes(state.status))
        throw Error("PREVIEW_UPDATE_CONFIRMATION_STATE_FAILED")
      return state.status === "installing" && state.version === plan.target.version
    },
    360000,
    "DOWNLOAD_NOT_READY",
  )
  return clickPreviewUpdateLinuxConfirmation({
    env: process.env,
    root,
    applicationPid: current.pid,
    version: plan.target.version,
    choice,
  })
}
async function connectRenderer(port) {
  const target = await wait(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined)
      if (!response?.ok) return
      const rows = await response.json()
      const match = rows.filter((row) => row.type === "page" && /^oc:\/\/renderer\//.test(row.url))
      if (match.length !== 1) return
      const endpoint = new URL(match[0].webSocketDebuggerUrl)
      if (
        endpoint.protocol !== "ws:" ||
        endpoint.hostname !== "127.0.0.1" ||
        endpoint.port !== String(port) ||
        !/^\/devtools\/page\/[A-Fa-f0-9-]+$/.test(endpoint.pathname)
      )
        throw Error("PREVIEW_UPDATE_RENDERER_ENDPOINT_INVALID")
      return endpoint.href
    },
    90000,
    "RENDERER_ENDPOINT_UNCONFIRMED",
  )
  const socket = new WebSocket(target)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(Error("PREVIEW_UPDATE_CDP_CONNECTION_FAILED"))
  })
  let next = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error || message.result?.exceptionDetails)
      return entry.reject(Error("PREVIEW_UPDATE_RENDERER_OPERATION_FAILED"))
    entry.resolve(message.result)
  }
  socket.onclose = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(Error("PREVIEW_UPDATE_RENDERER_CLOSED"))
    }
    pending.clear()
  }
  return {
    async evaluate(expression) {
      const id = ++next
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Error("PREVIEW_UPDATE_RENDERER_TIMEOUT"))
        }, 45000)
        pending.set(id, { resolve, reject, timer })
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        )
      })
      return response.result?.value
    },
    close: () => socket.close(),
  }
}
async function linuxProcess(pid, executable) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8")
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  const owner = await lstat(`/proc/${pid}`)
  const actual = await readlink(`/proc/${pid}/exe`)
  if (actual !== executable || owner.uid !== process.getuid() || !/^[1-9]\d*$/.test(fields[19]) || fields[0] === "Z")
    throw Error("PREVIEW_UPDATE_LINUX_PROCESS_MISMATCH")
  return { pid, birth: fields[19], executable }
}
async function linuxRestart(executable, previous) {
  const found = []
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === previous.pid) continue
    const path = await readlink(`/proc/${name}/exe`).catch(() => undefined)
    if (path !== executable) continue
    const args = (await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "")).split("\0")
    if (args.some((arg) => arg.startsWith("--type=")) || !args.includes("--remote-debugging-port=0")) continue
    const observed = await linuxProcess(Number(name), executable)
    if (BigInt(observed.birth) > BigInt(previous.birth)) found.push(observed)
  }
  if (found.length > 1) throw Error("PREVIEW_UPDATE_LINUX_RESTART_AMBIGUOUS")
  return found[0]
}
async function linuxExited(application) {
  const stat = await readFile(`/proc/${application.pid}/stat`, "utf8").catch((error) => {
    if (error.code === "ENOENT") return
    throw error
  })
  if (!stat) return true
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  return fields[19] !== application.birth || fields[0] === "Z"
}
async function startKeyring() {
  const directory = join(root, "keyring")
  await mkdir(directory, { mode: 0o700 })
  const service = spawn(
    "/usr/bin/gnome-keyring-daemon",
    ["--foreground", "--components=secrets", "--unlock", `--control-directory=${directory}`],
    {
      cwd: root,
      env: { ...process.env, XDG_DATA_HOME: directory },
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    },
  )
  let closed = false
  service.once("exit", () => {
    closed = true
  })
  service.once("error", () => {
    closed = true
  })
  service.stdin.end(randomBytes(32).toString("hex"))
  await wait(
    async () => {
      if (closed) throw Error("PREVIEW_UPDATE_KEYRING_EXITED")
      const owner = await command(
        "/usr/bin/gdbus",
        [
          "call",
          "--session",
          "--dest",
          "org.freedesktop.DBus",
          "--object-path",
          "/org/freedesktop/DBus",
          "--method",
          "org.freedesktop.DBus.GetConnectionUnixProcessID",
          "org.freedesktop.secrets",
        ],
        { allowFailure: true },
      )
      if (owner.code !== 0) return false
      if (owner.stdout.trim() !== `(uint32 ${service.pid},)`) throw Error("PREVIEW_UPDATE_KEYRING_OWNER_MISMATCH")
      const state = await command(
        "/usr/bin/gdbus",
        [
          "call",
          "--session",
          "--dest",
          "org.freedesktop.secrets",
          "--object-path",
          "/org/freedesktop/secrets/collection/login",
          "--method",
          "org.freedesktop.DBus.Properties.Get",
          "org.freedesktop.Secret.Collection",
          "Locked",
        ],
        { allowFailure: true },
      )
      return state.code === 0 && state.stdout.trim() === "(<false>,)"
    },
    15000,
    "KEYRING_NOT_READY",
  )
  return {
    async stop() {
      service.kill("SIGTERM")
      await wait(async () => closed, 10000, "KEYRING_CLOSE_UNCONFIRMED")
    },
  }
}
