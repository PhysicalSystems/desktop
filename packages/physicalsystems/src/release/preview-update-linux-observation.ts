// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { join } from "node:path"

export type LinuxRestartObservationPhase =
  | "before-confirmation"
  | "after-confirmation"
  | "attempt-recorded"
  | "authenticated"
  | "old-exited"
  | "target-package-verified"
  | "restart-poll"

type Observation =
  | "endpointFileSeen"
  | "freshEndpointSeen"
  | "browserReplyReceived"
  | "browserTransportUnavailable"
  | "browserProcessUnavailable"
  | "browserIdentityMatched"
  | "identityRejected"

/** Only finite flags leave the private fixture; no endpoint, PID, path or log. */
export function createLinuxRestartObservation() {
  let stderr = ""
  const value = {
    sampling: "stage-and-restart-polls" as const,
    phase: "not-started" as LinuxRestartObservationPhase | "not-started",
    samples: 0,
    observationsTruncated: false,
    endpointFileSeen: false,
    freshEndpointSeen: false,
    browserReplyReceived: false,
    browserTransportUnavailable: false,
    browserProcessUnavailable: false,
    browserIdentityMatched: false,
    identityRejected: false,
    stderr: {
      noChildProcessExe: false,
      processLaunchFailed: false,
      relauncherSyncFailed: false,
      relaunchTargetFailed: false,
      sandboxFatal: false,
    },
  }
  return {
    sample(phase: LinuxRestartObservationPhase) {
      value.phase = phase
      if (value.samples < 1024) value.samples++
      else value.observationsTruncated = true
    },
    observe(event: Observation) {
      value[event] = true
    },
    observeStderr(chunk: string) {
      stderr = (stderr + chunk.slice(-4096)).slice(-4096)
      value.stderr.noChildProcessExe ||= stderr.includes("No CHILD_PROCESS_EXE")
      value.stderr.processLaunchFailed ||= stderr.includes("base::LaunchProcess failed")
      value.stderr.relauncherSyncFailed ||= /read: unexpected result -?\d+/.test(stderr)
      value.stderr.relaunchTargetFailed ||= stderr.includes("failed to launch program")
      value.stderr.sandboxFatal ||=
        stderr.includes("No usable sandbox!") ||
        stderr.includes("The SUID sandbox helper binary was found, but is not configured correctly") ||
        /\bFATAL:[^\n]*(?:sandbox|zygote)/i.test(stderr)
    },
    snapshot() {
      return structuredClone(value)
    },
  }
}

export function parseLinuxBrowserEndpoint(contents: string) {
  const match =
    /^([1-9]\d{0,4})\n(\/devtools\/browser\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\n?$/.exec(
      contents,
    )
  if (!match || Number(match[1]) > 65535) return
  return `ws://127.0.0.1:${match[1]}${match[2]}`
}

/** Read only the two known profile locations. Freshness uses the browser UUID,
 * since a correctly relaunched browser can reuse the old ephemeral port. */
export async function readLinuxBrowserEndpoint(
  profile: string,
  previous: string,
  uid: number,
  observe: (event: Observation) => void = () => {},
) {
  const endpoints = new Set<string>()
  for (const folder of ["session", "desktop"]) {
    const directory = join(profile, folder)
    const parent = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (!parent) continue
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid)
      throw Error("PREVIEW_UPDATE_TARGET_DEBUG_FILE_UNOWNED")
    const handle = await open(
      join(directory, "DevToolsActivePort"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw Error("PREVIEW_UPDATE_TARGET_DEBUG_FILE_UNOWNED")
    })
    if (!handle) continue
    try {
      observe("endpointFileSeen")
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || before.size > 1024)
        throw Error("PREVIEW_UPDATE_TARGET_DEBUG_FILE_UNOWNED")
      const buffer = Buffer.alloc(1025)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const after = await handle.stat()
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) continue
      const endpoint = parseLinuxBrowserEndpoint(buffer.subarray(0, bytesRead).toString("utf8"))
      if (endpoint && endpoint !== previous) endpoints.add(endpoint)
    } finally {
      await handle.close()
    }
  }
  if (endpoints.size > 1) throw Error("PREVIEW_UPDATE_TARGET_DEBUG_ENDPOINT_AMBIGUOUS")
  const endpoint = [...endpoints][0]
  if (endpoint) observe("freshEndpointSeen")
  return endpoint
}

/** Read-only browser RPC. The caller must still bind this PID to the expected
 * executable, UID and newer process birth time before accepting a restart. */
export function readLinuxBrowserPid(endpoint: string, timeoutMs = 3000): Promise<number | undefined> {
  const parsed = new URL(endpoint)
  if (parseLinuxBrowserEndpoint(`${parsed.port}\n${parsed.pathname}`) !== endpoint)
    throw Error("PREVIEW_UPDATE_TARGET_DEBUG_ENDPOINT_INVALID")
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint)
    let settled = false
    const finish = (pid?: number, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      if (error) reject(error)
      else resolve(pid)
    }
    const timer = setTimeout(() => finish(), timeoutMs)
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "SystemInfo.getProcessInfo" }))
    socket.onerror = () => finish()
    socket.onclose = () => finish()
    socket.onmessage = (event) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 65536) throw Error()
        const reply = JSON.parse(event.data)
        if (reply.id !== 1) return
        const rows: unknown = reply.result?.processInfo
        if (reply.error || !Array.isArray(rows) || rows.length > 128) throw Error()
        const browser = rows.filter((row) => row && row.type === "browser")
        if (browser.length !== 1 || !Number.isSafeInteger(browser[0].id) || browser[0].id <= 0) throw Error()
        finish(browser[0].id)
      } catch {
        finish(undefined, Error("PREVIEW_UPDATE_TARGET_BROWSER_REPLY_INVALID"))
      }
    }
  })
}
