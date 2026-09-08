// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { browserObservationError } from "./browser-observation"
import {
  browserDiagnosticContext,
  browserDiagnosticMode,
  browserDiagnosticProbeURL,
  pendingBrowserDiagnostic,
  runBrowserFactoryDiagnostic,
} from "./browser-diagnostic"
import { validateBrowserProbeURL } from "./owned-review-browser"

const revision = "a".repeat(40)
const env: NodeJS.ProcessEnv = {
  CI: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "PhysicalSystems/desktop",
  GITHUB_WORKFLOW_REF: "PhysicalSystems/desktop/.github/workflows/desktop-release.yml@refs/heads/release-completion",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_OS: "Linux",
  BROWSER_DIAGNOSTIC_SOURCE_SHA: revision,
  GITHUB_SHA: revision,
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
}
const context = browserDiagnosticContext({ env, checkedOutRevision: revision, platform: "linux", architecture: "x64" })

test("actual diagnostic CLI rejects a local environment before creating or launching anything", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../../../../script/desktop-browser-diagnostic.ts", import.meta.url))],
    { env: { CI: "false" }, encoding: "utf8", timeout: 5000 },
  )
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr.trim()).toBe("BROWSER_DIAGNOSTIC_INCOMPLETE")
})

test("diagnostic requires the exact owned dispatched source and selected hosted platform", () => {
  expect(context).toEqual({ sourceRevision: revision, runId: "123", runAttempt: 1, platform: "linux-x64" })
  for (const changed of [
    { CI: "false" },
    { GITHUB_ACTIONS: "false" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REPOSITORY: "unowned/desktop" },
    { GITHUB_WORKFLOW_REF: "PhysicalSystems/desktop/.github/workflows/other.yml@refs/heads/main" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { RUNNER_OS: "Windows" },
    { BROWSER_DIAGNOSTIC_PLATFORM: "windows-x64" },
    { BROWSER_DIAGNOSTIC_PLATFORM: "unowned" },
    { BROWSER_DIAGNOSTIC_SOURCE_SHA: "main" },
    { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_ATTEMPT: "9007199254740992" },
  ])
    expect(() =>
      browserDiagnosticContext({
        env: { ...env, ...changed },
        checkedOutRevision: revision,
        platform: "linux",
        architecture: "x64",
      }),
    ).toThrow("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  for (const changed of [
    { checkedOutRevision: "b".repeat(40) },
    { platform: "win32" as const },
    { architecture: "arm64" },
  ])
    expect(() =>
      browserDiagnosticContext({
        env,
        checkedOutRevision: revision,
        platform: "linux",
        architecture: "x64",
        ...changed,
      }),
    ).toThrow("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
})

test("Windows selection is anchored to the real Windows host and only HTTP association scope", async () => {
  const windowsEnv = { ...env, RUNNER_OS: "Windows", BROWSER_DIAGNOSTIC_PLATFORM: "windows-x64" }
  const windows = browserDiagnosticContext({
    env: windowsEnv,
    checkedOutRevision: revision,
    platform: "win32",
    architecture: "x64",
  })
  expect(windows.platform).toBe("windows-x64")
  expect(() =>
    browserDiagnosticContext({ env: windowsEnv, checkedOutRevision: revision, platform: "linux", architecture: "x64" }),
  ).toThrow()
  for (const selected of [undefined, "linux-x64", "windows-arm64"])
    expect(() =>
      browserDiagnosticContext({
        env: { ...windowsEnv, BROWSER_DIAGNOSTIC_PLATFORM: selected },
        checkedOutRevision: revision,
        platform: "win32",
        architecture: "x64",
      }),
    ).toThrow()
  const calls: string[] = []
  const result = await runBrowserFactoryDiagnostic(windows, async () => {
    calls.push("acquire")
    return {
      stop: async () => {
        calls.push("stop")
      },
    }
  })
  expect(calls).toEqual(["acquire", "stop"])
  expect(result).toMatchObject({
    platform: "windows-x64",
    associationProtocol: "http",
    result: "COMPLETE",
    cleanup: "STOPPED",
    browserHandoff: "NOT_TESTED",
    providerLogin: "NOT_TESTED",
    qualification: false,
    publication: false,
  })
  expect(validateBrowserProbeURL(browserDiagnosticProbeURL)).toBe(browserDiagnosticProbeURL)
  expect(browserDiagnosticProbeURL).toStartWith("http://127.0.0.1:1/")
})

test("factory diagnostic starts once, stops once, and never produces product or provider qualification", async () => {
  const calls: string[] = []
  const result = await runBrowserFactoryDiagnostic(context, async () => {
    calls.push("start")
    return {
      stop: async () => {
        calls.push("stop")
      },
    }
  })
  expect(calls).toEqual(["start", "stop"])
  expect(result).toMatchObject({
    result: "COMPLETE",
    acquisition: "READY",
    cleanup: "STOPPED",
    retentionRequired: false,
  })
  expect(result).toMatchObject({
    qualification: false,
    publication: false,
    desktop: "NOT_TESTED",
    browserHandoff: "NOT_TESTED",
    providerLogin: "NOT_TESTED",
  })
  expect(pendingBrowserDiagnostic(context)).toMatchObject({
    result: "INCOMPLETE",
    cleanup: "UNCONFIRMED",
    retentionRequired: true,
  })
})

test("failed acquisition retains fixed failure and cleanup observations without retrying acquisition", async () => {
  let calls = 0
  const result = await runBrowserFactoryDiagnostic(context, async () => {
    calls++
    throw browserObservationError("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED", Error("PRIVATE-SECRET"), {
      browserPhase: "cleanup-identity",
      failedBrowserPhase: "identity-executable",
      cleanupFailurePhase: "cleanup-identity",
      pidObserved: true,
      birthVerified: false,
      syscallFailure: "OTHER",
    })
  })
  expect(calls).toBe(1)
  expect(result).toMatchObject({
    result: "FAILED",
    acquisition: "UNCONFIRMED",
    cleanup: "UNCONFIRMED",
    retentionRequired: true,
  })
  expect(result.browserObservation?.failedBrowserPhase).toBe("identity-executable")
  expect(result.browserObservation?.cleanupFailurePhase).toBe("cleanup-identity")
  expect(JSON.stringify(result)).not.toContain("PRIVATE")
})

test("cleanup failure after acquisition is retained, never retried or converted into completed diagnostic", async () => {
  let stops = 0
  const result = await runBrowserFactoryDiagnostic(context, async () => ({
    stop: async () => {
      stops++
      throw browserObservationError("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED", undefined, {
        browserPhase: "cleanup-observe",
        cleanupFailurePhase: "cleanup-observe",
        syscallFailure: "EACCES",
      })
    },
  }))
  expect(stops).toBe(1)
  expect(result).toMatchObject({
    result: "FAILED",
    acquisition: "READY",
    cleanup: "UNCONFIRMED",
    retentionRequired: true,
  })
  expect(result.browserObservation?.syscallFailure).toBe("EACCES")
})

test("only an authored stopped phase establishes cleanup after failed acquisition; arbitrary error data is omitted", async () => {
  for (const error of [
    Error("PRIVATE-CREDENTIAL"),
    { browserObservation: { browserPhase: "stopped", private: "PRIVATE" } },
  ]) {
    const result = await runBrowserFactoryDiagnostic(context, async () => {
      throw error
    })
    expect(result.cleanup).toBe("UNCONFIRMED")
    expect(result.browserObservation).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
  }
  const result = await runBrowserFactoryDiagnostic(context, async () => {
    throw browserObservationError("PROVIDER_REVIEW_BROWSER_UNCONFIRMED", undefined, {
      browserPhase: "stopped",
      failedBrowserPhase: "cdp-targets",
      birthVerified: true,
    })
  })
  expect(result).toMatchObject({
    result: "FAILED",
    acquisition: "UNCONFIRMED",
    cleanup: "STOPPED",
    retentionRequired: false,
  })
})

test("OS-loopback mode is an explicit Windows-only opt-in; ordinary factory behavior is unchanged", () => {
  const windows = { ...context, platform: "windows-x64" as const }
  expect(browserDiagnosticMode({}, windows)).toBe("acquisition")
  expect(browserDiagnosticMode({ BROWSER_DIAGNOSTIC_LOOPBACK: "0" }, context)).toBe("acquisition")
  expect(browserDiagnosticMode({ BROWSER_DIAGNOSTIC_LOOPBACK: "1" }, windows)).toBe("windows-os-loopback")
  for (const flag of ["true", "false", "", "2"])
    expect(() => browserDiagnosticMode({ BROWSER_DIAGNOSTIC_LOOPBACK: flag }, windows)).toThrow()
  expect(() => browserDiagnosticMode({ BROWSER_DIAGNOSTIC_LOOPBACK: "1" }, context)).toThrow()
  expect(pendingBrowserDiagnostic(windows, "windows-os-loopback")).toMatchObject({
    mode: "windows-os-loopback",
    osLoopbackHandoff: "NOT_TESTED",
    productOpener: "NOT_TESTED",
    qualification: false,
  })
})
