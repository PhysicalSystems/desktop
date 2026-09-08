// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, readdir, realpath } from "node:fs/promises"
import { join, win32 } from "node:path"
import { pendingBrowserDiagnostic, type BrowserDiagnosticContext } from "./browser-diagnostic"
import { browserObservationError, readBrowserObservation, type BrowserObservation } from "./browser-observation"
import { createBrowserHandoffTask } from "./browser-handoff-task"
import { captureOwnedBrowserDirectory, removeOwnedBrowserDirectory } from "./owned-browser-directory"
import { validateBrowserProbeURL, type OwnedReviewBrowser } from "./owned-review-browser"
import { startOwnedWindowsReviewBrowser } from "./owned-windows-review-browser"
import { requireDisposablePublicRunner } from "./public-qualification"
import {
  createWindowsReviewRequestTransport,
  windowsReviewNativeEnvironment,
  windowsReviewScriptBootstrap,
} from "./windows-review-native"

// Process.Start with UseShellExecute invokes the current user's existing URL
// association. A reused browser may return no Process object; ownership and
// navigation are established separately by the existing browser owner and GET.
// https://learn.microsoft.com/dotnet/api/system.diagnostics.process.start
export const windowsLoopbackOpenScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
try {
  $text=[Console]::In.ReadToEnd()
  if($text.Length -gt 1024){throw 'request'}
  $request=$text | ConvertFrom-Json
  if(@($request.PSObject.Properties).Count -ne 1 -or $request.url -isnot [string]){throw 'request'}
  if($request.url -cnotmatch '^http://127\.0\.0\.1:([1-9][0-9]{0,4})/physicalsystems-browser-review/[a-f0-9]{64}$' -or [int]$Matches[1] -gt 65535){throw 'url'}
  $info=[System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$request.url
  $info.UseShellExecute=$true
  $info.Verb='open'
  $opened=[System.Diagnostics.Process]::Start($info)
  if($null -ne $opened){$opened.Dispose()}
  [Console]::Out.Write('{"acknowledged":true}')
} catch {exit 1}
`

export function windowsLoopbackOpenArguments(executable: string) {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(windowsReviewScriptBootstrap(windowsLoopbackOpenScript), "utf16le").toString("base64"),
  ]
  if (executable.length * 2 + 3 + args.reduce((total, arg) => total + arg.length + 3, 0) > 32767)
    throw Error("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  return args
}

/** This adapter always executes the fixed script. Test injection supplies only
 * an inert child; production callers cannot supply code or an executable. */
export async function openWindowsLoopbackURL(
  input: { env: NodeJS.ProcessEnv; environment: NodeJS.ProcessEnv; root: string; url: string },
  io: { execute?: Parameters<typeof createWindowsReviewRequestTransport>[0]; platform?: NodeJS.Platform } = {},
) {
  const url = validateBrowserProbeURL(input.url)
  const platform = io.platform ?? process.platform
  if (platform !== "win32") throw Error("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  await requireDisposablePublicRunner(input.env, input.root, platform)
  const environment = {
    ...Object.fromEntries(
      ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].flatMap((key) =>
        input.environment[key] ? [[key, input.environment[key]!]] : [],
      ),
    ),
    ...windowsReviewNativeEnvironment(input.env, input.root),
  }
  const executable = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const args = windowsLoopbackOpenArguments(executable)
  const execute =
    io.execute ??
    ((options, complete) =>
      execFile(
        executable,
        args,
        {
          cwd: input.root,
          env: environment,
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 4096,
          timeout: options.timeout,
        },
        complete,
      ))
  const request = createWindowsReviewRequestTransport<{ url: string }>(execute, () => 12000)
  const result = await request({ url })
  return Boolean(
    result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      Object.keys(result).join(",") === "acknowledged" &&
      (result as { acknowledged?: unknown }).acknowledged === true,
  )
}

/** OS-only handoff diagnostic. No desktop process, product bridge, provider,
 * installer or qualified distribution is created by this controller. */
export async function runWindowsLoopbackDiagnostic(
  context: BrowserDiagnosticContext,
  input: { env: NodeJS.ProcessEnv; root: string },
  io: {
    acquire?: (input: { env: NodeJS.ProcessEnv; root: string; probeURL: string }) => Promise<OwnedReviewBrowser>
    open?: typeof openWindowsLoopbackURL
    timeoutMs?: number
    quiescenceTimeoutMs?: number
    platform?: NodeJS.Platform
  } = {},
) {
  if (context.platform !== "windows-x64" || (io.platform ?? process.platform) !== "win32")
    throw Error("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  await requireDisposablePublicRunner(input.env, input.root, io.platform ?? process.platform)
  const root = await realpath(input.root)
  if ((await readdir(root)).length) throw Error("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  const directory = await captureOwnedBrowserDirectory(root)
  const timeoutMs = io.timeoutMs ?? 12000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12000)
    throw Error("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  const quiescenceTimeoutMs = io.quiescenceTimeoutMs ?? 13000
  if (!Number.isInteger(quiescenceTimeoutMs) || quiescenceTimeoutMs < 1 || quiescenceTimeoutMs > 13000)
    throw Error("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  const report = pendingBrowserDiagnostic(context, "windows-os-loopback")
  const observation: BrowserObservation = {
    reviewPhase: "browser-acquisition",
    openerAcknowledged: false,
    requestObserved: false,
  }
  let browser: OwnedReviewBrowser | undefined
  let uncertain = false
  let acquiring = false
  let failure: unknown
  let host = ""
  let received = false
  let receive = () => {}
  const requestArrived = new Promise<void>((resolve) => {
    receive = resolve
  })
  const path = `/physicalsystems-browser-review/${randomBytes(32).toString("hex")}`
  const server = createServer(
    { maxHeaderSize: 4096, requestTimeout: 2000, headersTimeout: 2000 },
    (request, response) => {
      if (
        request.method !== "GET" ||
        request.url !== path ||
        request.headers.host !== host ||
        request.socket.remoteAddress !== "127.0.0.1" ||
        request.headers["content-length"] ||
        request.headers["transfer-encoding"]
      ) {
        response.writeHead(404, { connection: "close" }).end()
        return
      }
      received = true
      receive()
      response.writeHead(200, {
        "content-type": "text/plain",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        connection: "close",
      })
      response.end("Owned OS browser diagnostic. Desktop and provider sign-in are not tested.")
    },
  )
  server.maxConnections = 8
  server.on("clientError", (_error, socket) => {
    socket.destroy()
  })
  let task: ReturnType<typeof createBrowserHandoffTask> | undefined
  let openerSettled = false
  let opener: Promise<boolean> | undefined
  let expired = false
  let openerUnconfirmedAtDeadline = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string" || address.address !== "127.0.0.1")
      throw Error("BROWSER_HANDOFF_UNCONFIRMED")
    host = `127.0.0.1:${address.port}`
    const url = validateBrowserProbeURL(`http://${host}${path}`)
    const browserRoot = join(root, "browser")
    const openerRoot = join(root, "opener")
    await mkdir(browserRoot, { mode: 0o700 })
    await mkdir(openerRoot, { mode: 0o700 })
    acquiring = true
    browser = await (io.acquire ?? startOwnedWindowsReviewBrowser)({ env: input.env, root: browserRoot, probeURL: url })
    acquiring = false
    report.acquisition = "READY"
    report.osLoopbackHandoff = "UNCONFIRMED"
    task = createBrowserHandoffTask(browser, quiescenceTimeoutMs)
    const result = await Promise.race([
      (async () => {
        observation.reviewPhase = "opener"
        opener = (io.open ?? openWindowsLoopbackURL)({
          env: input.env,
          environment: browser!.environment,
          root: openerRoot,
          url,
        }).finally(() => {
          openerSettled = true
        })
        const opened = await opener
        observation.openerAcknowledged = opened === true
        if (!opened || expired) return false
        observation.reviewPhase = "target"
        if (!(await task!.confirm(url)) || expired) return false
        observation.reviewPhase = "request"
        await requestArrived
        return !expired
      })(),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          expired = true
          openerUnconfirmedAtDeadline = !openerSettled || observation.openerAcknowledged !== true
          task!.cancel()
          observation.handoffDeadlineExpired = true
          resolve(false)
        }, timeoutMs)
      }),
    ])
    if (!result) throw Error("BROWSER_HANDOFF_UNCONFIRMED")
    report.osLoopbackHandoff = "OBSERVED"
  } catch (error) {
    failure = error
    observation.failedReviewPhase ??= observation.reviewPhase
    if (report.acquisition === "NOT_STARTED") report.acquisition = "UNCONFIRMED"
  } finally {
    clearTimeout(timer)
    // The opener transport owns a 12s+500ms close bound. Never issue browser
    // cleanup while this mutation's helper or acknowledgment is uncertain.
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    if (opener && !openerSettled) {
      await Promise.race([
        opener.then(
          () => {},
          () => {},
        ),
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, quiescenceTimeoutMs)
        }),
      ])
      clearTimeout(drainTimer)
    }
    uncertain ||=
      acquiring ||
      openerUnconfirmedAtDeadline ||
      Boolean(opener && (!openerSettled || observation.openerAcknowledged !== true))
    const drained = await task?.drain()
    if (drained) {
      uncertain ||= !drained.settled
      Object.assign(observation, drained.observation)
    }
    if (openerUnconfirmedAtDeadline || (opener && (!openerSettled || observation.openerAcknowledged !== true)))
      observation.handoffQuiescence = "unconfirmed"
    observation.requestObserved = received
    try {
      observation.reviewPhase = "browser-cleanup"
      if (uncertain) browser?.releaseController?.()
      else if (browser) {
        await browser.stop()
        report.cleanup = "STOPPED"
      }
    } catch (error) {
      failure = error
      uncertain = true
    }
    server.closeAllConnections()
    const closed = await Promise.race([
      new Promise<boolean>((resolve) =>
        server.close((error) => resolve(!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING")),
      ),
      new Promise<false>((resolve) => {
        drainTimer = setTimeout(() => resolve(false), 2000)
      }),
    ])
    clearTimeout(drainTimer)
    uncertain ||= !closed
    if (!closed) server.unref()
    if (!uncertain)
      await removeOwnedBrowserDirectory(directory).catch((error) => {
        failure = error
        uncertain = true
      })
    if (uncertain) report.cleanup = "UNCONFIRMED"
    report.retentionRequired = uncertain
    report.result = !failure && !uncertain && report.osLoopbackHandoff === "OBSERVED" ? "COMPLETE" : "FAILED"
    report.browserObservation = readBrowserObservation(
      browserObservationError("BROWSER_HANDOFF_UNCONFIRMED", failure, { ...browser?.observation?.(), ...observation }),
    )
  }
  return report
}
