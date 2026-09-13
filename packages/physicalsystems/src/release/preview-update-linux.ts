// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process"
import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { requireDisposablePublicRunner } from "./public-qualification"

type NativeInput = { env: NodeJS.ProcessEnv; root: string; applicationPid: number; version: string }
type Dependencies = { spawn?: typeof spawn; timeoutMs?: number }
export type PreviewUpdateLinuxDialogDiagnostic = {
  applications: number
  ownedApplications: number
  windows: {
    role: "dialog" | "alert" | "frame" | "window" | "other"
    name: "update-title" | "target-message" | "empty" | "other"
    message: boolean
    install: number
    later: number
  }[]
}

/** The only diagnostic payload that may be retained by the native test driver. */
export class PreviewUpdateLinuxError extends Error {
  constructor(
    message: string,
    readonly nativeDialog?: PreviewUpdateLinuxDialogDiagnostic,
  ) {
    super(message)
    this.name = "PreviewUpdateLinuxError"
  }
}

/** Password-bearing authentication is confined to the disposable runner and a private pipe. */
export async function startPreviewUpdatePolkitAgent(
  input: NativeInput & { authUser: "ps-update-auth"; authPassword: string },
  dependencies: Dependencies = {},
) {
  await requireNativeRunner(input)
  if (input.authUser !== "ps-update-auth" || !/^[A-Za-z0-9_-]{32,128}$/.test(input.authPassword))
    throw new Error("PREVIEW_UPDATE_AUTHENTICATION_INPUT_INVALID")
  const helper = startHelper("polkit", input, dependencies)
  return { ready: helper.ready, authenticated: helper.completed, stop: helper.stop }
}

/** Invoke a real owned native button; this does not use CDP or synthesize app IPC. */
export async function clickPreviewUpdateLinuxConfirmation(
  input: NativeInput & { choice: "later" | "install" },
  dependencies: Dependencies = {},
) {
  await requireNativeRunner(input)
  if (!["later", "install"].includes(input.choice)) throw new Error("PREVIEW_UPDATE_DIALOG_INPUT_INVALID")
  const helper = startHelper("dialog", input, dependencies)
  try {
    await helper.completed
    await helper.closed
    return { action: input.choice, method: helper.method() }
  } finally {
    await helper.stop()
  }
}

async function requireNativeRunner(input: NativeInput) {
  await requireDisposablePublicRunner(input.env, input.root)
  if (
    input.env.PHYSICALSYSTEMS_UPDATER_TEST !== "1" ||
    input.env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
    input.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    input.env.RUNNER_ARCH !== "X64"
  )
    throw new Error("PREVIEW_UPDATE_DISPOSABLE_RUNNER_REQUIRED")
  if (process.platform !== "linux" || !process.getuid?.()) throw new Error("PREVIEW_UPDATE_NONROOT_LINUX_REQUIRED")
  if (
    !Number.isSafeInteger(input.applicationPid) ||
    input.applicationPid <= 1 ||
    !/^\d+\.\d+\.\d+-beta\.\d+$/.test(input.version)
  )
    throw new Error("PREVIEW_UPDATE_NATIVE_INPUT_INVALID")
  const marker = join(input.root, "preview-update-runner.json")
  const stat = await lstat(marker).catch(() => undefined)
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077 ||
    stat.size > 1024
  )
    throw new Error("PREVIEW_UPDATE_RUNNER_MARKER_INVALID")
  const value = await readFile(marker, "utf8")
    .then((text): unknown => JSON.parse(text))
    .catch(() => undefined)
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "kind,runId" ||
    !("kind" in value) ||
    value.kind !== "disposable-preview-update" ||
    !("runId" in value) ||
    value.runId !== input.env.GITHUB_RUN_ID
  )
    throw new Error("PREVIEW_UPDATE_RUNNER_MARKER_INVALID")
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  // Authentication completes after the user-facing native dialog. The caller may
  // not await it until later; an early native failure must still be retained.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

function startHelper(
  mode: "polkit" | "dialog",
  input: NativeInput & { authUser?: string; authPassword?: string; choice?: "later" | "install" },
  dependencies: Dependencies,
) {
  const ready = deferred<void>()
  const completed = deferred<void>()
  const closed = deferred<void>()
  const timeout = dependencies.timeoutMs ?? (mode === "polkit" ? 185_000 : 50_000)
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 185_000)
    throw new Error("PREVIEW_UPDATE_HELPER_TIMEOUT_INVALID")
  const env = Object.fromEntries(
    [
      "CI",
      "GITHUB_ACTIONS",
      "RUNNER_ENVIRONMENT",
      "RUNNER_OS",
      "GITHUB_RUN_ID",
      "RUNNER_TEMP",
      "PHYSICALSYSTEMS_UPDATER_TEST",
      "GITHUB_REPOSITORY",
      "GITHUB_EVENT_NAME",
      "RUNNER_ARCH",
      "HOME",
      "DISPLAY",
      "XAUTHORITY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ].flatMap((key) => (input.env[key] ? [[key, input.env[key]!]] : [])),
  )
  let child: ReturnType<typeof spawn>
  try {
    child = (dependencies.spawn ?? spawn)(
      "/usr/bin/python3",
      ["-I", "-B", "-u", fileURLToPath(new URL("./preview-update-linux.py", import.meta.url)), mode],
      {
        cwd: input.root,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...env,
          PATH: "/usr/bin:/bin",
          LC_ALL: "C.UTF-8",
          LANGUAGE: "en",
          NO_AT_BRIDGE: "0",
          GTK_MODULES: "atk-bridge",
        },
      },
    )
  } catch {
    throw new Error("PREVIEW_UPDATE_NATIVE_HELPER_LAUNCH_FAILED")
  }
  let stopping = false
  let ended = false
  let registered = false
  let observed = false
  let method: "at-spi" | "x11-ocr" | undefined
  let diagnostic: PreviewUpdateLinuxDialogDiagnostic | undefined
  let failure: Error | undefined
  let buffer = ""
  const fail = (code: string) => {
    failure ??= new PreviewUpdateLinuxError(code, diagnostic)
    ready.reject(failure)
    completed.reject(failure)
  }
  const timer = setTimeout(() => {
    fail("PREVIEW_UPDATE_NATIVE_HELPER_TIMEOUT")
    child.kill("SIGTERM")
  }, timeout)
  child.stderr?.resume() // Raw native diagnostics may include private information.
  child.stdin?.on("error", () => fail("PREVIEW_UPDATE_NATIVE_HELPER_PIPE_FAILED"))
  child.once("error", () => fail("PREVIEW_UPDATE_NATIVE_HELPER_LAUNCH_FAILED"))
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    if (buffer.length > 4096) {
      fail("PREVIEW_UPDATE_NATIVE_HELPER_OUTPUT_INVALID")
      child.kill("SIGTERM")
      return
    }
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        const event: unknown = JSON.parse(line)
        if (!event || typeof event !== "object" || !("event" in event)) throw new Error()
        if (event.event === "diagnostic" && mode === "dialog" && !observed && !diagnostic && "data" in event) {
          diagnostic = validateDialogDiagnostic(event.data)
          continue
        }
        if (event.event === "ready" && mode === "polkit" && !registered && !observed) {
          registered = true
          ready.resolve()
          continue
        }
        if (event.event === "authenticated" && mode === "polkit" && registered && !observed) {
          observed = true
          completed.resolve()
          continue
        }
        if (
          event.event === "clicked" &&
          mode === "dialog" &&
          !observed &&
          "action" in event &&
          event.action === input.choice &&
          "method" in event &&
          (event.method === "at-spi" || event.method === "x11-ocr")
        ) {
          method = event.method
          observed = true
          ready.resolve()
          completed.resolve()
          continue
        }
        if (
          event.event === "failed" &&
          "code" in event &&
          typeof event.code === "string" &&
          nativeFailureCodes.has(event.code)
        ) {
          fail("PREVIEW_UPDATE_" + event.code)
          continue
        }
        throw new Error()
      } catch {
        fail("PREVIEW_UPDATE_NATIVE_HELPER_OUTPUT_INVALID")
        child.kill("SIGTERM")
      }
    }
  })
  child.once("close", (code) => {
    ended = true
    clearTimeout(timer)
    if (failure || (!stopping && (code !== 0 || !observed || mode === "polkit"))) {
      fail("PREVIEW_UPDATE_NATIVE_HELPER_EXITED")
      closed.reject(failure!)
      return
    }
    if (!observed) fail("PREVIEW_UPDATE_NATIVE_HELPER_STOPPED")
    closed.resolve()
  })
  // Explicit fields prevent env, credentials or unrelated driver data entering
  // the child configuration. In particular the password is absent from argv/env.
  child.stdin?.write(
    JSON.stringify({
      root: input.root,
      applicationPid: input.applicationPid,
      version: input.version,
      ...(mode === "polkit"
        ? { authUser: input.authUser, authPassword: input.authPassword }
        : { choice: input.choice }),
    }) + "\n",
  )
  if (mode === "dialog") child.stdin?.end()
  let cleanup: Promise<void> | undefined
  return {
    ready: ready.promise,
    completed: completed.promise,
    closed: closed.promise,
    method() {
      if (!method) throw new Error("PREVIEW_UPDATE_NATIVE_HELPER_OUTPUT_INVALID")
      return method
    },
    stop() {
      return (cleanup ??= (async () => {
        stopping = true
        if (!ended) {
          child.stdin?.end('{"command":"stop"}\n')
          const terminate = setTimeout(() => child.kill("SIGTERM"), 2000)
          const force = setTimeout(() => child.kill("SIGKILL"), 4000)
          try {
            await closed.promise
          } finally {
            clearTimeout(terminate)
            clearTimeout(force)
          }
        } else await closed.promise
      })())
    },
  }
}

function validateDialogDiagnostic(value: unknown): PreviewUpdateLinuxDialogDiagnostic {
  const record = (input: unknown): input is Record<string, unknown> =>
    Boolean(input) && typeof input === "object" && !Array.isArray(input)
  const count = (input: unknown): input is number =>
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= 64
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== "applications,ownedApplications,windows" ||
    !count(value.applications) ||
    !count(value.ownedApplications) ||
    value.ownedApplications > value.applications ||
    !Array.isArray(value.windows) ||
    value.windows.length > 16
  )
    throw new Error("PREVIEW_UPDATE_NATIVE_HELPER_OUTPUT_INVALID")
  for (const window of value.windows) {
    if (
      !record(window) ||
      Object.keys(window).sort().join() !== "install,later,message,name,role" ||
      typeof window.role !== "string" ||
      !["dialog", "alert", "frame", "window", "other"].includes(window.role) ||
      typeof window.name !== "string" ||
      !["update-title", "target-message", "empty", "other"].includes(window.name) ||
      typeof window.message !== "boolean" ||
      !count(window.install) ||
      !count(window.later)
    )
      throw new Error("PREVIEW_UPDATE_NATIVE_HELPER_OUTPUT_INVALID")
  }
  return structuredClone(value) as PreviewUpdateLinuxDialogDiagnostic
}

// Finite authored diagnostics only: never return raw PTY, Python, or AT-SPI text.
const nativeFailureCodes = new Set([
  "INVALID_APPLICATION_PID",
  "APPLICATION_OWNER_MISMATCH",
  "APPLICATION_EXECUTABLE_MISMATCH",
  "APPLICATION_IDENTITY_UNAVAILABLE",
  "DISPOSABLE_NONROOT_RUNNER_REQUIRED",
  "DISPOSABLE_RUNNER_REQUIRED",
  "RUNNER_PATH_INVALID",
  "RUNNER_MARKER_INVALID",
  "AUTHENTICATION_OUTPUT_LIMIT",
  "AUTHENTICATION_REJECTED",
  "AUTHENTICATION_ACTION_MISMATCH",
  "AUTHENTICATION_IDENTITY_MISMATCH",
  "AUTHENTICATION_RETRY_REFUSED",
  "AUTHENTICATION_IDENTITY_MISSING",
  "AUTHENTICATION_PASSWORD_NOT_OBSERVED",
  "AUTHENTICATION_IDENTITY_INVALID",
  "AUTHENTICATION_SECRET_INVALID",
  "AGENT_CONTROL_INVALID",
  "AGENT_REGISTRATION_INVALID",
  "AGENT_REGISTRATION_FAILED",
  "APPLICATION_IDENTITY_CHANGED",
  "AUTHENTICATION_AGENT_EXITED",
  "AUTHENTICATION_BEFORE_REGISTRATION",
  "AUTHENTICATION_ECHO_ENABLED",
  "AUTHENTICATION_TIMEOUT",
  "AUTHENTICATION_COMMAND_MISMATCH",
  "NATIVE_DIALOG_TREE_LIMIT",
  "NATIVE_DIALOG_AMBIGUOUS",
  "NATIVE_DIALOG_INPUT_INVALID",
  "NATIVE_ACCESSIBILITY_UNAVAILABLE",
  "NATIVE_DIALOG_OWNER_MISMATCH",
  "NATIVE_DIALOG_BUTTON_UNAVAILABLE",
  "NATIVE_DIALOG_ACTION_UNAVAILABLE",
  "NATIVE_DIALOG_ACTION_AMBIGUOUS",
  "NATIVE_DIALOG_ACTION_FAILED",
  "NATIVE_DIALOG_NOT_FOUND",
  "NATIVE_X11_UNAVAILABLE",
  "NATIVE_DIALOG_WINDOW_CHANGED",
  "NATIVE_DIALOG_CAPTURE_INVALID",
  "NATIVE_DIALOG_OCR_INVALID",
  "NATIVE_DIALOG_OCR_MISMATCH",
  "NATIVE_DIALOG_OCR_FAILED",
  "INVALID_NATIVE_HELPER_INPUT",
  "INVALID_NATIVE_HELPER_MODE",
  "NATIVE_HELPER_FAILED",
])
