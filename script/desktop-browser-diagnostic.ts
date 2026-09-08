// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  browserDiagnosticContext,
  browserDiagnosticMode,
  browserDiagnosticProbeURL,
  pendingBrowserDiagnostic,
  runBrowserFactoryDiagnostic,
} from "../packages/physicalsystems/src/release/browser-diagnostic"
import { startOwnedReviewBrowser } from "../packages/physicalsystems/src/release/owned-review-browser"
import { startOwnedWindowsReviewBrowser } from "../packages/physicalsystems/src/release/owned-windows-review-browser"
import { runWindowsLoopbackDiagnostic } from "../packages/physicalsystems/src/release/windows-loopback-diagnostic"
import { createBrowserPrivateDiagnostic } from "../packages/physicalsystems/src/release/browser-private-diagnostic"
import { requireDisposablePublicRunner } from "../packages/physicalsystems/src/release/public-qualification"
import {
  captureOwnedBrowserDirectory,
  removeOwnedBrowserDirectory,
} from "../packages/physicalsystems/src/release/owned-browser-directory"
import { readBrowserObservation } from "../packages/physicalsystems/src/release/browser-observation"

try {
  if (process.argv.length !== 2) throw new Error("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  const source = resolve(import.meta.dir, "..")
  const context = browserDiagnosticContext({
    env: process.env,
    checkedOutRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim(),
  })
  const mode = browserDiagnosticMode(process.env, context)
  const privateDiagnostic =
    mode === "windows-os-loopback"
      ? createBrowserPrivateDiagnostic({ context, publicKeyPem: process.env.BROWSER_DIAGNOSTIC_PUBLIC_KEY_PEM })
      : undefined
  const temporary = await realpath(process.env.RUNNER_TEMP!)
  const reports = join(temporary, "desktop-browser-diagnostic-report")
  await mkdir(reports, { mode: 0o700 })
  await requireDisposablePublicRunner(process.env, reports)
  const report = join(reports, "browser-diagnostic.json")
  // If the command deadline interrupts the controller, retained evidence stays
  // explicitly incomplete. Only this fixed report is uploaded, never profiles.
  await writeFile(report, JSON.stringify(pendingBrowserDiagnostic(context, mode), null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  })
  // Diagnostic branch only: match the candidate's Windows browser-root depth.
  // The exclusive enclosing directory is retained on every uncertain outcome.
  const enclosing = context.platform === "windows-x64" ? join(temporary, "desktop-release") : undefined
  if (enclosing) await mkdir(enclosing, { mode: 0o700 })
  const directory = enclosing ? await captureOwnedBrowserDirectory(enclosing) : undefined
  const qualification = enclosing ? await mkdtemp(join(enclosing, "desktop-qualification-")) : undefined
  const packaged = qualification ? await mkdtemp(join(qualification, "packaged-")) : undefined
  const nested = packaged ? join(packaged, "browser-handoff-review") : undefined
  if (nested) await mkdir(nested, { mode: 0o700 })
  const root = nested ?? (await mkdtemp(join(temporary, "private-browser-factory-")))
  const acquire = context.platform === "windows-x64" ? startOwnedWindowsReviewBrowser : startOwnedReviewBrowser
  const result =
    mode === "windows-os-loopback"
      ? await runWindowsLoopbackDiagnostic(context, {
          env: process.env,
          root,
          ...(privateDiagnostic ? { unknownExecutableSink: privateDiagnostic.unknownExecutableSink } : {}),
        })
      : await runBrowserFactoryDiagnostic(context, () =>
          acquire({ env: process.env, root, probeURL: browserDiagnosticProbeURL }),
        )
  if (directory && result.cleanup === "STOPPED" && !result.retentionRequired) {
    await removeOwnedBrowserDirectory(directory).catch((error) => {
      result.result = "FAILED"
      result.cleanup = "UNCONFIRMED"
      result.retentionRequired = true
      result.browserObservation = { ...result.browserObservation, ...readBrowserObservation(error) }
    })
  }
  const completed = join(reports, "browser-diagnostic.next.json")
  const receipt = Buffer.from(JSON.stringify(result, null, 2) + "\n")
  await writeFile(completed, receipt, { mode: 0o600, flag: "wx" })
  await rename(completed, report)
  console.log(JSON.stringify(result))
  if (privateDiagnostic) {
    const outputDirectory = join(temporary, "desktop-browser-sealed-diagnostics")
    await mkdir(outputDirectory, { mode: 0o700 })
    const sealed = await privateDiagnostic.seal({ temporary, outputDirectory, receipt })
    console.log(
      JSON.stringify({ encryptedDiagnostic: sealed.status, ...("reason" in sealed ? { reason: sealed.reason } : {}) }),
    )
    if (sealed.status === "FAILED") process.exitCode = 1
  }
  if (result.result !== "COMPLETE") process.exitCode = 1
} catch {
  // Filesystem and native errors can contain private paths or transport data.
  console.error("BROWSER_DIAGNOSTIC_INCOMPLETE")
  process.exitCode = 1
}
