// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { desktopIdentity } from "./identity"
import { publicNativeJobReceipt, publicNativeReceipt, validatePublicNativeJob } from "./public-native-receipts"
import { simulatedPublicNativeFixture } from "./public-native-fixture"

test("current real smoke can author only its demonstrated installed checks; legacy auth is not V2 evidence", () => {
  for (const platform of ["windows-x64", "linux-x64"] as const) {
    const f = simulatedPublicNativeFixture(platform)
    const receipt = publicNativeReceipt(f)
    const statuses = Object.fromEntries(receipt.checks.map((check) => [check.id, check.status]))
    expect(statuses).toEqual({
      "native-credential-storage": "NOT_TESTED",
      "provider-browser-sign-in": "NOT_TESTED",
      "fresh-install": "PASS",
      upgrade: "NOT_TESTED",
      "failed-upgrade-recovery": "NOT_TESTED",
      "uninstall-reinstall": "PASS",
      "configuration-preservation": "PASS",
      "platform-display": "NOT_TESTED",
    })
    expect(receipt.artifact).toEqual({ name: f.artifact.name, bytes: f.artifact.bytes, sha256: f.artifact.sha256 })
    expect(JSON.stringify(receipt)).not.toContain("SIMULATED FIXTURE ONLY")
  }
  const portable = publicNativeReceipt(simulatedPublicNativeFixture("linux-x64", 1))
  expect(portable.checks.every((check) => check.status === "NOT_TESTED")).toBe(true)
})

test("fixed actual probe IDs can complete the receipt while failures and uncertain cleanup stay failures", () => {
  const f = simulatedPublicNativeFixture("windows-x64", 0, true)
  expect(publicNativeReceipt(f).checks.every((check) => check.status === "PASS")).toBe(true)
  for (const status of ["FAIL", "BLOCKED", "NOT_TESTED"] as const) {
    const changed = structuredClone(f)
    changed.report.checks.find((check) => check.id === "native-v2-credential-probe")!.status = status
    expect(publicNativeReceipt(changed).checks.find((check) => check.id === "native-credential-storage")?.status).toBe(
      status,
    )
    changed.report.checks.find((check) => check.id === "cleanup")!.status = "FAIL"
    expect(publicNativeReceipt(changed).checks.every((check) => check.status === "FAIL")).toBe(true)
  }
})

test("candidate, foreign artifact/source, missing compiled identity and inconsistent signing never author native PASS", () => {
  const f = simulatedPublicNativeFixture("windows-x64", 0, true)
  for (const report of [
    { ...f.report, identity: desktopIdentity("candidate") },
    { ...f.report, kind: "candidate-smoke" },
    { ...f.report, sourceRevision: "0".repeat(40) },
    { ...f.report, compiledIdentity: undefined },
    { ...f.report, artifact: { ...f.report.artifact, sha256: "0".repeat(64) } },
    { ...f.report, signing: { ...f.report.signing, status: "NOT_TESTED" } },
    { ...f.report, checks: [...f.report.checks, f.report.checks[0]] },
  ])
    expect(() => publicNativeReceipt({ ...f, report })).toThrow()
})

test("native job receipts bind one exact hosted platform, run attempt and immutable installer inventory", () => {
  const f = simulatedPublicNativeFixture()
  const artifacts = [
    {
      name: f.artifact.name,
      bytes: f.artifact.bytes,
      sha256: f.artifact.sha256,
      smokeSha256: "a".repeat(64),
      nativeSha256: "b".repeat(64),
    },
  ]
  const input = { ...f, artifacts, platform: "windows-x64" as const }
  const receipt = publicNativeJobReceipt(input)
  expect(validatePublicNativeJob(receipt, input)).toEqual(receipt)
  artifacts[0]!.sha256 = "0".repeat(64)
  expect(receipt.artifacts[0]!.sha256).toBe(f.artifact.sha256)
  for (const env of [
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_RUN_ATTEMPT: "0" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_SHA: "0".repeat(40) },
    { RUNNER_OS: "Linux" },
  ])
    expect(() => publicNativeJobReceipt({ ...input, env: { ...f.env, ...env } })).toThrow()
  for (const change of [{ runAttempt: 2 }, { platform: "linux-x64" }, { artifacts: [] }, { extra: "unknown" }])
    expect(() => validatePublicNativeJob({ ...receipt, ...change }, input)).toThrow()
})
