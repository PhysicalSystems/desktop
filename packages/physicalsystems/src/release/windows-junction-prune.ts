// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process"
import { lstat, mkdtemp, readdir, realpath } from "node:fs/promises"
import { win32 } from "node:path"
import { browserObservationError, readBrowserObservation } from "./browser-observation"
import {
  captureOwnedBrowserDirectory,
  removeOwnedBrowserDirectory,
  type OwnedBrowserDirectoryAnchors,
} from "./owned-browser-directory"
import { requireDisposablePublicRunner } from "./public-qualification"
import { windowsDirectoryProbeDefinition } from "./windows-directory-observation"
import { junctionPruneDefinition } from "./windows-junction-prune-native"
import {
  createWindowsReviewRequestTransport,
  windowsReviewNativeEnvironment,
  windowsReviewScriptBootstrap,
} from "./windows-review-native"

const statuses = [
  "COMPLETE",
  "BOUNDED",
  "IDENTITY_UNCONFIRMED",
  "DELETE_UNCONFIRMED",
  "UNREADABLE",
  "CLOSE_UNCONFIRMED",
] as const
type PruneResult = Readonly<{ status: (typeof statuses)[number]; entries: number; linksRemoved: number }>
type PrepareStatus =
  | PruneResult["status"]
  | "NOT_STARTED"
  | "INVALID_RESPONSE"
  | "TRANSPORT_UNCONFIRMED"
  | "CONTROLLER_UNCONFIRMED"
type PruneOutcome = Readonly<{ result?: PruneResult; status: PrepareStatus; quiescence: "confirmed" | "unconfirmed" }>
const failure = (
  status: PrepareStatus = "NOT_STARTED",
  quiescence: "not-started" | "confirmed" | "unconfirmed" = "not-started",
) =>
  browserObservationError("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED", undefined, {
    browserPhase: "cleanup-profile",
    directoryPrepareStatus: status,
    directoryPrepareQuiescence: quiescence,
    ...(quiescence === "unconfirmed" ? { handoffQuiescence: "unconfirmed" as const } : {}),
  })

function request(anchors: OwnedBrowserDirectoryAnchors) {
  const anchor = (value: OwnedBrowserDirectoryAnchors["root"]) => {
    if (
      !value ||
      typeof value.path !== "string" ||
      value.path.length > 2048 ||
      !/^[A-Za-z]:\\[^:\r\n\0"<>|?*]+$/.test(value.path) ||
      win32.normalize(value.path) !== value.path ||
      typeof value.dev !== "bigint" ||
      value.dev < 0n ||
      value.dev > 0xffffffffn ||
      typeof value.ino !== "bigint" ||
      value.ino < 1n ||
      value.ino > 0xffffffffffffffffn
    )
      throw failure()
    return Object.freeze({ path: value.path, dev: value.dev.toString(), ino: value.ino.toString() })
  }
  try {
    const root = anchor(anchors.root)
    const parent = anchor(anchors.parent)
    if (win32.dirname(root.path) !== parent.path || root.path === parent.path) throw failure()
    return Object.freeze({ root, parent })
  } catch {
    throw failure()
  }
}

function result(value: unknown): PruneResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).length !== 3 ||
    Object.keys(row).some((key) => !["status", "entries", "linksRemoved"].includes(key)) ||
    !Object.hasOwn(row, "status") ||
    typeof row.status !== "string" ||
    !statuses.includes(row.status as PruneResult["status"]) ||
    typeof row.entries !== "number" ||
    !Number.isInteger(row.entries) ||
    row.entries < 0 ||
    row.entries > 8192 ||
    typeof row.linksRemoved !== "number" ||
    !Number.isInteger(row.linksRemoved) ||
    row.linksRemoved < 0 ||
    row.linksRemoved > row.entries
  )
    return
  return Object.freeze({
    status: row.status as PruneResult["status"],
    entries: row.entries,
    linksRemoved: row.linksRemoved,
  })
}

/** Inert executor seam. Actual execution below always supplies the fixed
 * script; this transport cannot turn malformed output into deletion success. */
export function createWindowsJunctionPruneTransport(
  execute: Parameters<typeof createWindowsReviewRequestTransport>[0],
  closeTimeoutMs = 500,
) {
  const native = createWindowsReviewRequestTransport<ReturnType<typeof request>>(execute, () => 12000, closeTimeoutMs)
  return async (anchors: OwnedBrowserDirectoryAnchors): Promise<PruneOutcome> => {
    const input = request(anchors)
    try {
      const decoded = result(await native(input))
      return { result: decoded, status: decoded?.status ?? "INVALID_RESPONSE", quiescence: "confirmed" }
    } catch (error) {
      return {
        status: "TRANSPORT_UNCONFIRMED",
        quiescence: readBrowserObservation(error)?.handoffQuiescence === "unconfirmed" ? "unconfirmed" : "confirmed",
      }
    }
  }
}

/** Production uses this ordering too: callback completion is insufficient,
 * uncertain native closure never permits even controller-directory deletion. */
export async function finishWindowsJunctionPrune(
  prune: () => Promise<PruneOutcome>,
  removeController: () => Promise<void>,
) {
  try {
    const outcome = await prune()
    if (outcome.quiescence !== "confirmed" || outcome.result?.status === "CLOSE_UNCONFIRMED")
      throw failure(outcome.status, outcome.quiescence)
    try {
      await removeController()
    } catch {
      throw failure("CONTROLLER_UNCONFIRMED", "confirmed")
    }
    if (outcome.result?.status !== "COMPLETE") throw failure(outcome.status, outcome.quiescence)
  } catch (error) {
    const observation = readBrowserObservation(error)
    throw failure(observation?.directoryPrepareStatus, observation?.directoryPrepareQuiescence)
  }
}

export const windowsJunctionPruneScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
try {
Add-Type -TypeDefinition @'
${windowsDirectoryProbeDefinition}
${junctionPruneDefinition}
'@
  $line=[Console]::In.ReadLine()
  if($null -eq $line -or $line.Length -gt 16384){throw 'request'}
  $r=$line | ConvertFrom-Json
  $result=[JunctionPruner]::Run([DirectoryDenialProbe+NativeOps]::new(),[JunctionPruner+NativeMutationOps]::new(),$r.parent.path,[IO.Path]::GetFileName($r.root.path),[uint64]$r.parent.dev,[uint64]$r.parent.ino,[uint64]$r.root.dev,[uint64]$r.root.ino)
  [Console]::Out.Write(($result | ConvertTo-Json -Depth 3 -Compress))
} catch { [Console]::Out.Write('{"status":"UNREADABLE","entries":0,"linksRemoved":0}') }
`

/** Only the disposable Windows runner may prune its captured browser tree.
 * A beforeRemove failure poisons the caller's memoized removal owner. */
export async function pruneOwnedWindowsJunctions(input: {
  env: NodeJS.ProcessEnv
  anchors: OwnedBrowserDirectoryAnchors
}): Promise<void> {
  try {
    if (process.platform !== "win32") throw failure()
    const env = { ...input.env }
    const validated = request(input.anchors)
    const anchors = Object.freeze({
      root: Object.freeze({
        path: validated.root.path,
        dev: BigInt(validated.root.dev),
        ino: BigInt(validated.root.ino),
      }),
      parent: Object.freeze({
        path: validated.parent.path,
        dev: BigInt(validated.parent.dev),
        ino: BigInt(validated.parent.ino),
      }),
    })
    await requireDisposablePublicRunner(env, anchors.root.path)
    for (const anchor of [anchors.parent, anchors.root]) {
      const stat = await lstat(anchor.path, { bigint: true })
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== anchor.dev ||
        stat.ino !== anchor.ino ||
        (await realpath(anchor.path)) !== anchor.path
      )
        throw failure()
    }
    const controller = await captureOwnedBrowserDirectory(
      await mkdtemp(win32.join(anchors.parent.path, "junction-prune-")),
    )
    await requireDisposablePublicRunner(env, controller.root)
    if (win32.dirname(controller.root) !== anchors.parent.path || (await readdir(controller.root)).length)
      throw failure()
    const environment = windowsReviewNativeEnvironment(env, controller.root)
    const executable = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsReviewScriptBootstrap(windowsJunctionPruneScript), "utf16le").toString("base64"),
    ]
    if (executable.length * 2 + 3 + args.reduce((sum, arg) => sum + arg.length + 3, 0) > 32767) throw failure()
    const prune = createWindowsJunctionPruneTransport((deadline, complete) =>
      execFile(
        executable,
        args,
        {
          cwd: controller.root,
          env: environment,
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 16384,
          timeout: deadline.timeout,
        },
        complete,
      ),
    )
    await finishWindowsJunctionPrune(
      () => prune(anchors),
      () => removeOwnedBrowserDirectory(controller),
    )
  } catch (error) {
    const observation = readBrowserObservation(error)
    throw failure(observation?.directoryPrepareStatus, observation?.directoryPrepareQuiescence)
  }
}
