// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join, win32 } from "node:path"
import type { BrowserDiagnosticContext } from "./browser-diagnostic"
import type { WindowsUnknownExecutableSnapshot } from "./owned-windows-review-browser"
import { isDiagnosticsPublicKey, sealDiagnostics, type SealedDiagnosticsResult } from "./sealed-diagnostics"

type Result =
  | SealedDiagnosticsResult
  | { status: "NOT_COLLECTED"; reason: "NO_UNKNOWN_EXECUTABLE" }
  | { status: "FAILED"; reason: "INVALID_SNAPSHOT" | "INVALID_RECEIPT" | "PRIVATE_CLEANUP_UNCONFIRMED" }
const failure = () => Error("BROWSER_DIAGNOSTIC_PRIVATE_CONTEXT_UNCONFIRMED")

/** The only collection capability is created after strict recipient validation.
 * Private values remain in this closure until sealed; no plaintext read API. */
export function createBrowserPrivateDiagnostic(input: { publicKeyPem?: string; context: BrowserDiagnosticContext }) {
  if (!input.publicKeyPem?.trim()) return undefined
  if (
    !isDiagnosticsPublicKey(input.publicKeyPem) ||
    input.context.platform !== "windows-x64" ||
    !/^[a-f0-9]{40}$/.test(input.context.sourceRevision) ||
    !/^[1-9][0-9]{0,19}$/.test(input.context.runId) ||
    !Number.isSafeInteger(input.context.runAttempt) ||
    input.context.runAttempt < 1
  )
    throw failure()
  const publicKeyPem = input.publicKeyPem
  const context = Object.freeze({
    sourceRevision: input.context.sourceRevision,
    runId: input.context.runId,
    runAttempt: input.context.runAttempt,
    platform: input.context.platform,
  })
  let attempted = false
  let invalid = false
  let snapshot: WindowsUnknownExecutableSnapshot | undefined
  let sealing: Promise<Result> | undefined
  const unknownExecutableSink = (value: WindowsUnknownExecutableSnapshot) => {
    if (attempted || sealing) return
    attempted = true
    try {
      if (!Array.isArray(value) || !value.length || value.length > 8) throw failure()
      snapshot = Object.freeze(
        value.map((item) => {
          if (
            !item ||
            typeof item !== "object" ||
            Object.keys(item).sort().join(",") !==
              "exactProfile,executable,parent,parentOwned,pid,sameSession,sameSid,validBirth" ||
            typeof item.executable !== "string" ||
            item.executable.length < 1 ||
            item.executable.length > 2048 ||
            !win32.isAbsolute(item.executable) ||
            /[\r\n\0]/.test(item.executable) ||
            !Number.isSafeInteger(item.pid) ||
            item.pid < 1 ||
            item.pid > 0xffffffff ||
            !Number.isSafeInteger(item.parent) ||
            item.parent < 0 ||
            item.parent > 0xffffffff ||
            [item.parentOwned, item.sameSid, item.sameSession, item.validBirth, item.exactProfile].some(
              (value) => typeof value !== "boolean",
            )
          )
            throw failure()
          return Object.freeze({
            executable: item.executable,
            pid: item.pid,
            parent: item.parent,
            parentOwned: item.parentOwned,
            sameSid: item.sameSid,
            sameSession: item.sameSession,
            validBirth: item.validBirth,
            exactProfile: item.exactProfile,
          })
        }),
      )
    } catch {
      invalid = true
      snapshot = undefined
    }
  }
  return {
    unknownExecutableSink,
    seal(options: { temporary: string; outputDirectory: string; receipt: Uint8Array }): Promise<Result> {
      return (sealing ??= (async () => {
        if (invalid) return { status: "FAILED", reason: "INVALID_SNAPSHOT" } as const
        if (!snapshot) return { status: "NOT_COLLECTED", reason: "NO_UNKNOWN_EXECUTABLE" } as const
        const bytes = Buffer.from(options.receipt)
        try {
          if (bytes.length < 1 || bytes.length > 128 * 1024) throw failure()
          const receipt = JSON.parse(bytes.toString("utf8"))
          if (
            receipt.sourceRevision !== context.sourceRevision ||
            receipt.runId !== context.runId ||
            receipt.runAttempt !== context.runAttempt ||
            receipt.platform !== context.platform ||
            receipt.mode !== "windows-os-loopback" ||
            receipt.kind !== "owned-browser-factory-diagnostic" ||
            receipt.qualification !== false ||
            receipt.publication !== false ||
            receipt.productOpener !== "NOT_TESTED"
          )
            throw failure()
        } catch {
          snapshot = undefined
          return { status: "FAILED", reason: "INVALID_RECEIPT" } as const
        }
        const receiptSha256 = createHash("sha256").update(bytes).digest("hex")
        let root: string | undefined
        let result: Result = { status: "FAILED", reason: "SEAL_FAILED" }
        try {
          const temporary = await realpath(options.temporary)
          const outputDirectory = await realpath(options.outputDirectory)
          root = await realpath(await mkdtemp(join(temporary, "private-browser-executable-")))
          const plaintext = Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              kind: "private-windows-unknown-executables",
              binding: "sanitized-browser-diagnostic-receipt",
              receiptSha256,
              context,
              processes: snapshot,
            }),
          )
          try {
            await writeFile(join(root, "diagnostic.txt"), plaintext, { flag: "wx", mode: 0o600 })
          } finally {
            plaintext.fill(0)
          }
          result = await sealDiagnostics({
            root,
            publicKeyPem,
            output: join(outputDirectory, `${receiptSha256}.sealed.json`),
            context: {
              runId: context.runId,
              runAttempt: context.runAttempt,
              sourceRevision: context.sourceRevision,
              artifactSha256: receiptSha256,
            },
          })
        } catch {
          result = { status: "FAILED", reason: "SEAL_FAILED" }
        } finally {
          snapshot = undefined
          if (root)
            await rm(root, { recursive: true }).catch(() => {
              result = { status: "FAILED", reason: "PRIVATE_CLEANUP_UNCONFIRMED" }
            })
        }
        return result
      })())
    },
  }
}
