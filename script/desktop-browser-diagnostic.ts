// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  browserDiagnosticContext,
  browserDiagnosticProbeURL,
  pendingBrowserDiagnostic,
  runBrowserFactoryDiagnostic,
} from "../packages/physicalsystems/src/release/browser-diagnostic"
import { startOwnedReviewBrowser } from "../packages/physicalsystems/src/release/owned-review-browser"
import { startOwnedWindowsReviewBrowser } from "../packages/physicalsystems/src/release/owned-windows-review-browser"
import { requireDisposablePublicRunner } from "../packages/physicalsystems/src/release/public-qualification"

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
  const temporary = await realpath(process.env.RUNNER_TEMP!)
  const reports = join(temporary, "desktop-browser-diagnostic-report")
  await mkdir(reports, { mode: 0o700 })
  await requireDisposablePublicRunner(process.env, reports)
  const report = join(reports, "browser-diagnostic.json")
  // If the command deadline interrupts the controller, retained evidence stays
  // explicitly incomplete. Only this fixed report is uploaded, never profiles.
  await writeFile(report, JSON.stringify(pendingBrowserDiagnostic(context), null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  })
  const root = await mkdtemp(join(temporary, "private-browser-factory-"))
  const acquire = context.platform === "windows-x64" ? startOwnedWindowsReviewBrowser : startOwnedReviewBrowser
  const result = await runBrowserFactoryDiagnostic(context, () =>
    acquire({ env: process.env, root, probeURL: browserDiagnosticProbeURL }),
  )
  const completed = join(reports, "browser-diagnostic.next.json")
  await writeFile(completed, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  await rename(completed, report)
  console.log(JSON.stringify(result))
  if (result.result !== "COMPLETE") process.exitCode = 1
} catch {
  // Filesystem and native errors can contain private paths or transport data.
  console.error("BROWSER_DIAGNOSTIC_INCOMPLETE")
  process.exitCode = 1
}
