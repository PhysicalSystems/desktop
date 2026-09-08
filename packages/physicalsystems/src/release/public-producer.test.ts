// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { releaseInputDigest } from "./inputs"
import type { ReleaseInputs } from "./inputs"
import { publicReviewDigest } from "./public-downloads"
import {
  freezePublicProducerPolicy,
  preparePublicProducerInputs,
  publicSmokeCanContinue,
  validatePublicProducerPolicy,
  withPublicWindowsSigning,
} from "./public-producer"

const signing = { provider: "pfx" as const, publisher: "Fixture Publisher", certificateThumbprint: "A".repeat(40) }
const source = "a".repeat(40)
const canary = "TEST-ONLY-PRIVATE-PRODUCER-CANARY"
const env = () => ({
  GITHUB_REPOSITORY: "PhysicalSystems/desktop",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: source,
  DESKTOP_PUBLIC_BUILD_ENABLED: "true",
  DESKTOP_WINDOWS_SIGNING_POLICY: JSON.stringify(signing),
})

test("public preparation admits only enabled owned main dispatch with an explicit public signing policy", () => {
  expect(freezePublicProducerPolicy(env())).toEqual({
    schemaVersion: 1,
    kind: "public-desktop-producer-policy",
    sourceRevision: source,
    windowsSigning: signing,
    publication: false,
  })
  for (const override of [
    { GITHUB_REPOSITORY: "someone/desktop" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_REF: "refs/tags/v1" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_EVENT_NAME: "workflow_call" },
    { GITHUB_SHA: "main" },
    { DESKTOP_PUBLIC_BUILD_ENABLED: "false" },
    { DESKTOP_PUBLIC_BUILD_ENABLED: "" },
  ])
    expect(() => freezePublicProducerPolicy({ ...env(), ...override })).toThrow()
  for (const value of [
    "",
    "{",
    canary,
    JSON.stringify({ ...signing, password: canary }),
    JSON.stringify({ ...signing, provider: "unsigned" }),
    JSON.stringify({ ...signing, certificateThumbprint: "a".repeat(40) }),
    " ".repeat(8193),
  ]) {
    try {
      freezePublicProducerPolicy({ ...env(), DESKTOP_WINDOWS_SIGNING_POLICY: value })
      throw new Error("Expected rejection")
    } catch (error) {
      expect(String(error)).toContain("DESKTOP_WINDOWS_SIGNING_POLICY")
      expect(String(error)).not.toContain(canary)
    }
  }
})

test("public inputs freeze the separately verified source, release digest and signing policy", () => {
  const policy = freezePublicProducerPolicy(env())
  // The boundary consumes source-verified ReleaseInputs; a minimal fixture here
  // exercises its additional digest/source binding without staging an app.
  const partial = {
    source: { repository: "PhysicalSystems/desktop", revision: source },
    version: "0.1.0-beta.1",
    channel: "preview",
    publication: false,
  }
  const release = { ...partial, sha256: releaseInputDigest(partial) } as ReleaseInputs
  const input = {
    policy,
    expectedPolicySha256: publicReviewDigest(policy),
    sourceRevision: source,
    release,
    expectedInputsSha256: release.sha256,
  }
  const result = preparePublicProducerInputs(input)
  expect(result.inputs.identity.kind).toBe("public")
  expect(result.inputs.identity.appId).toBe("systems.physical.desktop")
  expect(result.inputs.releaseInputsSha256).toBe(release.sha256)
  expect(result.inputs.publication).toBe(false)
  expect(result.sha256).toBe(publicReviewDigest(result.inputs))
  policy.windowsSigning.publisher = "Changed after freeze"
  expect(result.inputs.windowsSigning.publisher).toBe(signing.publisher)
  expect(() => preparePublicProducerInputs(input)).toThrow("trusted preparation digest")

  const original = freezePublicProducerPolicy(env())
  for (const override of [
    { expectedPolicySha256: "0".repeat(64) },
    { sourceRevision: "b".repeat(40) },
    { expectedInputsSha256: "0".repeat(64) },
    { release: { ...release, version: "0.2.0-beta.1" } },
    { release: { ...release, publication: true } },
  ])
    expect(() => preparePublicProducerInputs({ ...input, policy: original, ...override } as typeof input)).toThrow()
  const extra = { ...original, approved: true }
  expect(() => validatePublicProducerPolicy(extra, publicReviewDigest(extra), source)).toThrow("exact source")
})

test("temporary PFX is private, packaging-only, and removed after success or failure", async () => {
  const bytes = Buffer.from(canary)
  let certificate = ""
  for (const fails of [false, true]) {
    const result = withPublicWindowsSigning(
      signing,
      {
        PATH: "fixture-path",
        PHYSICALSYSTEMS_PFX_BASE64: bytes.toString("base64"),
        WIN_CSC_KEY_PASSWORD: "fixture-password",
        AZURE_CLIENT_SECRET: canary,
        Csc_Link: canary,
        PhysicalSystems_Pfx_File: "/wrong/file",
      },
      async (selected) => {
        certificate = selected.PHYSICALSYSTEMS_PFX_FILE!
        expect(await readFile(certificate)).toEqual(bytes)
        if (process.platform !== "win32") expect((await lstat(certificate)).mode & 0o777).toBe(0o600)
        expect(selected.PATH).toBe("fixture-path")
        expect(selected.WIN_CSC_KEY_PASSWORD).toBe("fixture-password")
        for (const key of ["PHYSICALSYSTEMS_PFX_BASE64", "AZURE_CLIENT_SECRET", "Csc_Link", "PhysicalSystems_Pfx_File"])
          expect(selected[key]).toBeUndefined()
        if (fails) throw new Error("Fixture packaging failure")
        return "built"
      },
    )
    if (fails) await expect(result).rejects.toThrow("Fixture packaging failure")
    else expect(await result).toBe("built")
    expect(await lstat(certificate).catch(() => undefined)).toBeUndefined()
    expect(await lstat(dirname(certificate)).catch(() => undefined)).toBeUndefined()
  }
})

test("missing/malformed PFX cannot enter packaging and Azure receives only its selected credentials", async () => {
  let entered = false
  for (const value of [undefined, "", "not-base64!", "Zg=", "Zh==", "A".repeat(1_398_105)])
    await expect(
      withPublicWindowsSigning(
        signing,
        { PHYSICALSYSTEMS_PFX_BASE64: value, WIN_CSC_KEY_PASSWORD: "fixture" },
        async () => {
          entered = true
        },
      ),
    ).rejects.toThrow()
  await expect(
    withPublicWindowsSigning(signing, { PHYSICALSYSTEMS_PFX_BASE64: "Zg==" }, async () => {
      entered = true
    }),
  ).rejects.toThrow("password")
  expect(entered).toBe(false)
  const azure = {
    provider: "azure-trusted-signing" as const,
    publisher: "Fixture Publisher",
    endpoint: "https://eus.codesigning.azure.net",
    account: "fixture",
    certificateProfile: "fixture",
  }
  await expect(
    withPublicWindowsSigning(azure, {}, async () => {
      entered = true
    }),
  ).rejects.toThrow("service identity")
  expect(entered).toBe(false)
  const selected = await withPublicWindowsSigning(
    azure,
    {
      AZURE_TENANT_ID: "tenant",
      AZURE_CLIENT_ID: "client",
      AZURE_CLIENT_SECRET: "fixture-secret",
      PHYSICALSYSTEMS_PFX_BASE64: canary,
      WIN_CSC_KEY_PASSWORD: canary,
      Azure_Other: canary,
    },
    async (value) => value,
  )
  expect(selected).toEqual({
    AZURE_TENANT_ID: "tenant",
    AZURE_CLIENT_ID: "client",
    AZURE_CLIENT_SECRET: "fixture-secret",
  })
})

test("the real producer collection command refuses absent independent workflow anchors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "public-producer-boundary-"))
  try {
    const summary = join(directory, "summary.md")
    const script = fileURLToPath(new URL("../../../../script/desktop-public-producer.ts", import.meta.url))
    const result = spawnSync(process.execPath, [script, "collect"], {
      cwd: directory,
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary },
      encoding: "utf8",
      timeout: 10000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Missing PUBLIC_DOWNLOADED_DIRECTORY")
    expect(result.stderr).not.toContain(directory)
    await expect(readFile(summary, "utf8")).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("public smoke continues only after exact-artifact confirmed cleanup, never on missing or duplicate evidence", () => {
  const policy = freezePublicProducerPolicy(env())
  const partial = {
    source: { repository: "PhysicalSystems/desktop", revision: source },
    version: "0.1.0-beta.1",
    channel: "preview",
    publication: false,
  }
  const release = { ...partial, sha256: releaseInputDigest(partial) } as ReleaseInputs
  const prepared = preparePublicProducerInputs({
    policy,
    expectedPolicySha256: publicReviewDigest(policy),
    sourceRevision: source,
    release,
    expectedInputsSha256: release.sha256,
  })
  const artifact = { name: "fixture.deb", format: "deb" as const, bytes: 1, sha256: "b".repeat(64), sha512: "unused" }
  const report = {
    kind: "unqualified-public-desktop-smoke",
    result: "UNQUALIFIED",
    publication: false,
    sourceRevision: source,
    publicBuildInputsSha256: prepared.sha256,
    releaseInputsSha256: release.sha256,
    artifact: { name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256 },
    checks: [
      { id: "cleanup", status: "PASS" },
      { id: "uninstall", status: "PASS" },
      { id: "native-secret-service-cleanup", status: "PASS" },
      { id: "linux-temporary-cleanup", status: "PASS" },
      { id: "provider-browser-sign-in", status: "NOT_TESTED" },
    ],
  }
  const input = { report, artifact, build: prepared.inputs, publicBuildInputsSha256: prepared.sha256 }
  expect(publicSmokeCanContinue(input)).toBe(true)
  for (const id of ["cleanup", "uninstall", "native-secret-service-cleanup", "linux-temporary-cleanup"])
    for (const status of ["NOT_TESTED", "BLOCKED", "FAIL"])
      expect(
        publicSmokeCanContinue({
          ...input,
          report: { ...report, checks: report.checks.map((check) => (check.id === id ? { ...check, status } : check)) },
        }),
      ).toBe(false)
  for (const id of ["native-secret-service-cleanup", "linux-temporary-cleanup"]) {
    expect(
      publicSmokeCanContinue({
        ...input,
        report: { ...report, checks: report.checks.filter((check) => check.id !== id) },
      }),
    ).toBe(false)
    expect(() =>
      publicSmokeCanContinue({
        ...input,
        report: {
          ...report,
          checks: report.checks.map((check) => (check.id === id ? { ...check, status: "RETAINED" } : check)),
        },
      }),
    ).toThrow()
  }
  expect(publicSmokeCanContinue({ ...input, report: { ...report, checks: report.checks.slice(1) } })).toBe(false)
  expect(
    publicSmokeCanContinue({
      ...input,
      report: { ...report, checks: [...report.checks, { id: "installer-signature", status: "FAIL" }] },
    }),
  ).toBe(false)
  for (const override of [
    { result: "PASS" },
    { publication: true },
    { publicBuildInputsSha256: "c".repeat(64) },
    { artifact: { ...report.artifact, sha256: "c".repeat(64) } },
    { checks: [...report.checks, report.checks[0]] },
  ])
    expect(() => publicSmokeCanContinue({ ...input, report: { ...report, ...override } })).toThrow()
  expect(publicSmokeCanContinue({ ...input, artifact: { ...artifact, format: "AppImage" } })).toBe(false)
  expect(
    publicSmokeCanContinue({
      ...input,
      artifact: { ...artifact, format: "AppImage" },
      report: { ...report, checks: [...report.checks, { id: "linux-sandbox-cleanup", status: "PASS" }] },
    }),
  ).toBe(true)
  const windows = { ...input, artifact: { ...artifact, format: "nsis" as const } }
  expect(publicSmokeCanContinue(windows)).toBe(false)
  expect(
    publicSmokeCanContinue({
      ...windows,
      report: { ...report, checks: [...report.checks, { id: "public-signing", status: "PASS" }] },
    }),
  ).toBe(true)
  for (const status of ["FAIL", "BLOCKED", "NOT_TESTED"])
    expect(
      publicSmokeCanContinue({
        ...windows,
        report: { ...report, checks: [...report.checks, { id: "public-signing", status }] },
      }),
    ).toBe(false)
  for (const id of ["public-signing", "installer-signature", "payload-signing"])
    expect(
      publicSmokeCanContinue({ ...input, report: { ...report, checks: [...report.checks, { id, status: "FAIL" }] } }),
    ).toBe(false)
})
