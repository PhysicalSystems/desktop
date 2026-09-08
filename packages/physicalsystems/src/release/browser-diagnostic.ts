// SPDX-License-Identifier: Apache-2.0
import { readBrowserObservation, type BrowserObservation } from "./browser-observation"
import type { OwnedReviewBrowser } from "./owned-review-browser"

export type BrowserDiagnosticContext = { sourceRevision: string; runId: string; runAttempt: number }
export type BrowserDiagnosticReport = BrowserDiagnosticContext & {
  schemaVersion: 1
  kind: "owned-browser-factory-diagnostic"
  platform: "linux-x64"
  result: "COMPLETE" | "FAILED" | "INCOMPLETE"
  acquisition: "NOT_STARTED" | "READY" | "UNCONFIRMED"
  cleanup: "STOPPED" | "UNCONFIRMED"
  retentionRequired: boolean
  browserObservation?: BrowserObservation
  desktop: "NOT_TESTED"
  browserHandoff: "NOT_TESTED"
  providerLogin: "NOT_TESTED"
  qualification: false
  publication: false
}

/** This diagnostic is available only on an exact workflow-dispatched Linux
 * hosted-runner revision. It has no arbitrary source or browser override. */
export function browserDiagnosticContext(input: {
  env: NodeJS.ProcessEnv
  checkedOutRevision: string
  platform?: NodeJS.Platform
  architecture?: string
}): BrowserDiagnosticContext {
  const env = input.env
  if (
    (input.platform ?? process.platform) !== "linux" ||
    (input.architecture ?? process.arch) !== "x64" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.RUNNER_OS !== "Linux" ||
    !env.GITHUB_WORKFLOW_REF?.startsWith("PhysicalSystems/desktop/.github/workflows/desktop-release.yml@refs/heads/") ||
    !/^[a-f0-9]{40}$/.test(env.BROWSER_DIAGNOSTIC_SOURCE_SHA ?? "") ||
    env.BROWSER_DIAGNOSTIC_SOURCE_SHA !== env.GITHUB_SHA ||
    env.BROWSER_DIAGNOSTIC_SOURCE_SHA !== input.checkedOutRevision ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT))
  )
    throw new Error("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  return Object.freeze({
    sourceRevision: env.BROWSER_DIAGNOSTIC_SOURCE_SHA!,
    runId: env.GITHUB_RUN_ID!,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  })
}

export function pendingBrowserDiagnostic(context: BrowserDiagnosticContext): BrowserDiagnosticReport {
  return {
    schemaVersion: 1,
    kind: "owned-browser-factory-diagnostic",
    sourceRevision: context.sourceRevision,
    runId: context.runId,
    runAttempt: context.runAttempt,
    platform: "linux-x64",
    result: "INCOMPLETE",
    acquisition: "NOT_STARTED",
    cleanup: "UNCONFIRMED",
    retentionRequired: true,
    desktop: "NOT_TESTED",
    browserHandoff: "NOT_TESTED",
    providerLogin: "NOT_TESTED",
    qualification: false,
    publication: false,
  }
}

/** The existing factory owns all launch/cleanup decisions. A failed acquisition
 * may already have attempted cleanup; never retry mutation outside that owner. */
export async function runBrowserFactoryDiagnostic(
  context: BrowserDiagnosticContext,
  acquire: () => Promise<Pick<OwnedReviewBrowser, "stop">>,
): Promise<BrowserDiagnosticReport> {
  const report = pendingBrowserDiagnostic(context)
  try {
    const browser = await acquire()
    report.acquisition = "READY"
    await browser.stop()
    report.cleanup = "STOPPED"
    report.retentionRequired = false
    report.result = "COMPLETE"
    return report
  } catch (error) {
    if (report.acquisition === "NOT_STARTED") report.acquisition = "UNCONFIRMED"
    report.result = "FAILED"
    report.browserObservation = readBrowserObservation(error)
    // Only the factory's authored terminal phase establishes that its failed
    // acquisition nevertheless stopped processes and removed its owned root.
    if (report.browserObservation?.browserPhase === "stopped") {
      report.cleanup = "STOPPED"
      report.retentionRequired = false
    }
    return report
  }
}
