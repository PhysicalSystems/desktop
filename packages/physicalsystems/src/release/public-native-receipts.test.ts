// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { desktopIdentity } from "./identity"
import { publicNativeJobReceipt, publicNativeReceipt, validatePublicNativeJob } from "./public-native-receipts"
import { simulatedPublicNativeFixture } from "./public-native-fixture"

test("unsigned preview retains every native gate and rejects false signing claims", () => {
  const f = simulatedPublicNativeFixture("windows-x64", 0, true, { provider: "unsigned-preview" })
  expect(f.report.signing.status).toBe("UNSIGNED_PREVIEW")
  expect(f.report.signature.status).toBe("UNSIGNED")
  expect(publicNativeReceipt(f).checks.every((check) => check.status === "PASS")).toBe(true)
  for (const id of ["native-provider-browser-probe", "native-v2-credential-probe", "native-upgrade-probe"]) {
    const changed = structuredClone(f)
    changed.report.checks = changed.report.checks.filter((check) => check.id !== id)
    expect(publicNativeReceipt(changed).checks.some((check) => check.status === "NOT_TESTED")).toBe(true)
  }
  for (const status of ["FAIL", "BLOCKED", "NOT_TESTED"] as const) {
    const changed = structuredClone(f)
    changed.report.checks.find((check) => check.id === "public-unsigned-preview")!.status = status
    expect(publicNativeReceipt(changed).checks.every((check) => check.status === status)).toBe(true)
  }
  const signing = f.report.signing
  if (signing.status !== "UNSIGNED_PREVIEW") throw new Error("Expected an unsigned fixture receipt")
  for (const report of [
    { ...f.report, checks: [...f.report.checks, { id: "public-signing", status: "PASS", detail: "false claim" }] },
    { ...f.report, signature: { status: "PASS", trust: "WINDOWS_AUTHENTICODE_VALID" } },
    { ...f.report, signing: { ...signing, status: "PASS" } },
    { ...f.report, signing: { ...signing, installer: { ...signing.installer, publisher: "invented" } } },
    { ...f.report, signing: { ...signing, executable: { ...signing.executable, sha256: "0".repeat(64) } } },
  ])
    expect(() => publicNativeReceipt({ ...f, report })).toThrow()
})

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

test("optional loopback browser handoff cannot establish provider sign-in and cannot hide a failed handoff", () => {
  const complete = simulatedPublicNativeFixture("windows-x64", 0, true)
  const login = (input: typeof complete) =>
    publicNativeReceipt(input).checks.find((check) => check.id === "provider-browser-sign-in")!.status
  for (const status of ["PASS", "NOT_TESTED", "FAIL", "BLOCKED"] as const) {
    const changed = structuredClone(complete)
    changed.report.checks.find((check) => check.id === "native-browser-handoff-probe")!.status = status
    expect(login(changed)).toBe(status === "FAIL" || status === "BLOCKED" ? status : "PASS")
    changed.report.checks = changed.report.checks.filter((check) => check.id !== "native-provider-browser-probe")
    expect(login(changed)).toBe(status === "FAIL" || status === "BLOCKED" ? status : "NOT_TESTED")
  }
  complete.report.checks = complete.report.checks.filter((check) => check.id !== "native-browser-handoff-probe")
  expect(login(complete)).toBe("PASS")
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
