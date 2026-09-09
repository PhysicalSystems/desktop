// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { desktopIdentity } from "./identity"
import { releaseInputDigest } from "./inputs"
import { publicReviewDigest, validateDistributionFacts } from "./public-downloads"
import {
  qualificationReport,
  requiredQualificationChecks,
  verifyWindowsVersionInfo,
  qualificationFailureCode,
} from "./qualification"
import type { PublicBuildInputs } from "./public-build"
import {
  packagedQualificationArguments,
  loadPublicQualification,
  requireDisposablePublicRunner,
  verifyPublicPackagedIdentity,
  verifyPublicAuthenticode,
  verifyPublicSignaturePair,
  unimplementedPublicChecks,
  unqualifiedPublicSmokeReport,
} from "./public-qualification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
function fixture() {
  // Synthetic metadata and bytes only. This is not a signed executable or native test.
  const release = {
    schemaVersion: 1,
    version: "0.1.0-beta.1",
    channel: "preview",
    source: { revision: "a".repeat(40) },
    publication: false,
    sha256: "",
  }
  release.sha256 = releaseInputDigest(release)
  const build: PublicBuildInputs = {
    schemaVersion: 1,
    kind: "public-desktop-build",
    sourceRevision: release.source.revision,
    releaseInputsSha256: release.sha256,
    version: release.version,
    channel: "preview",
    identity: desktopIdentity("public"),
    windowsSigning: {
      provider: "pfx",
      publisher: "Synthetic Fixture Publisher",
      certificateThumbprint: "C".repeat(40),
    },
    publication: false,
  }
  const mode = { build, publicBuildInputsSha256: publicReviewDigest(build), releaseInputsSha256: release.sha256 }
  const mainBytes = Buffer.from("synthetic compiled main fixture")
  const compiledIdentity = {
    schemaVersion: 1,
    kind: "compiled-desktop-identity",
    identity: "public",
    publicBuildInputsSha256: mode.publicBuildInputsSha256,
    mainSha256: sha(mainBytes),
  }
  return {
    mode,
    archive: {
      metadata: { name: build.identity.packageName, version: build.version },
      releaseInputs: release,
      publicInputs: build,
      compiledIdentity,
      mainBytes,
    },
  }
}
async function inputFixture() {
  const root = await mkdtemp(join(tmpdir(), "public-qualification-"))
  roots.push(root)
  const data = fixture()
  const file = join(root, "public-inputs.json")
  await writeFile(file, JSON.stringify(data.mode.build))
  const args = [
    "--artifact",
    join(root, "fixture.deb"),
    "--evidence",
    join(root, "evidence"),
    "--report",
    join(root, "receipt.json"),
    "--version",
    data.mode.build.version,
  ]
  const publicArgs = [
    "--public-inputs",
    file,
    "--expected-public-build-sha256",
    data.mode.publicBuildInputsSha256,
    "--expected-inputs-sha256",
    data.mode.releaseInputsSha256,
  ]
  return { ...data, root, file, args, publicArgs }
}

test("public qualification is an all-or-none anchored mode and cannot select arbitrary executables", async () => {
  const f = await inputFixture()
  expect(await loadPublicQualification(packagedQualificationArguments(f.args))).toBeUndefined()
  expect(await loadPublicQualification(packagedQualificationArguments([...f.args, ...f.publicArgs]))).toEqual(f.mode)
  for (const extra of [
    f.publicArgs.slice(0, 2),
    f.publicArgs.slice(2),
    [...f.publicArgs, "--executable-name", "untrusted.exe"],
    [...f.publicArgs, "--public-inputs", f.file],
    ["--version", "0.1.0-beta.2"],
  ])
    expect(() => packagedQualificationArguments([...f.args, ...extra])).toThrow()
  const opts = packagedQualificationArguments([...f.args, ...f.publicArgs])
  for (const changed of [
    { ...opts, "expected-inputs-sha256": "0".repeat(64) },
    { ...opts, "expected-public-build-sha256": "0".repeat(64) },
    { ...opts, version: "0.1.0-beta.2" },
  ])
    await expect(loadPublicQualification(changed)).rejects.toThrow("PACKAGED_PUBLIC_INPUTS_INVALID")
  await writeFile(f.file, "credential-private-trap")
  await expect(loadPublicQualification(opts)).rejects.toThrow("PACKAGED_PUBLIC_INPUTS_INVALID")
})

test("public identity verifies final main bytes, both independent input digests and embedded source/version", () => {
  const f = fixture()
  expect(verifyPublicPackagedIdentity(f.mode, f.archive).identity).toBe("public")
  for (const archive of [
    { ...f.archive, metadata: { ...f.archive.metadata, name: desktopIdentity("candidate").packageName } },
    { ...f.archive, metadata: { ...f.archive.metadata, version: "0.1.0-beta.2" } },
    { ...f.archive, compiledIdentity: { ...f.archive.compiledIdentity, identity: "candidate" } },
    { ...f.archive, mainBytes: Buffer.from("changed main") },
    { ...f.archive, releaseInputs: { ...f.archive.releaseInputs, source: { revision: "b".repeat(40) } } },
    { ...f.archive, releaseInputs: { ...f.archive.releaseInputs, extra: "digest mutation" } },
    { ...f.archive, publicInputs: { ...f.archive.publicInputs, channel: "stable" } },
  ])
    expect(() => verifyPublicPackagedIdentity(f.mode, archive)).toThrow("PACKAGED_PUBLIC_IDENTITY_MISMATCH")
  expect(() =>
    verifyPublicPackagedIdentity({ ...f.mode, publicBuildInputsSha256: "0".repeat(64) }, f.archive),
  ).toThrow()
})

test("both public Windows signatures must validate the pinned publisher and PFX certificate", () => {
  const f = fixture()
  const good = { Status: "Valid", Publisher: "Synthetic Fixture Publisher", Thumbprint: "C".repeat(40) }
  const pair = {
    mode: f.mode,
    installer: good,
    executable: good,
    installerSha256: "d".repeat(64),
    executableSha256: "e".repeat(64),
  }
  expect(verifyPublicSignaturePair(pair).executable.sha256).toBe(pair.executableSha256)
  for (const bad of [
    { ...good, Status: "NotSigned" },
    { ...good, Status: "HashMismatch" },
    { ...good, Publisher: "Another Publisher" },
    { ...good, Thumbprint: "F".repeat(40) },
    { Status: "Valid", Thumbprint: good.Thumbprint },
    null,
  ]) {
    for (const entry of [
      { ...pair, installer: bad },
      { ...pair, executable: bad },
    ]) {
      try {
        verifyPublicSignaturePair(entry)
        throw new Error("incorrect success")
      } catch (error) {
        expect(["PACKAGED_PUBLIC_SIGNATURE_INVALID", "PACKAGED_PUBLIC_SIGNATURE_POLICY_MISMATCH"]).toContain(
          qualificationFailureCode(error),
        )
      }
    }
  }
  const azure = {
    provider: "azure-trusted-signing" as const,
    publisher: good.Publisher,
    endpoint: "https://weu.codesigning.azure.net",
    account: "fixture",
    certificateProfile: "fixture",
  }
  expect(verifyPublicAuthenticode(good, azure).certificateThumbprint).toBe(good.Thumbprint)
  expect(() => verifyPublicAuthenticode({ ...good, Publisher: "Another Publisher" }, azure)).toThrow()
  const pe = { ProductName: "Physical Systems", FileVersion: "0.1.0-beta.1", ProductVersion: "0.1.0.0" }
  expect(verifyWindowsVersionInfo(pe, f.mode.build.version, "public").productName).toBe("Physical Systems")
  expect(() => verifyWindowsVersionInfo(pe, f.mode.build.version)).toThrow()
})

test("unsigned preview observes both unsigned files without claiming verified publisher trust", () => {
  const f = fixture()
  f.mode.build.windowsSigning = { provider: "unsigned-preview" }
  f.mode.publicBuildInputsSha256 = publicReviewDigest(f.mode.build)
  const observation = { Status: "NotSigned", Publisher: null, Thumbprint: null }
  const pair = {
    mode: f.mode,
    installer: observation,
    executable: observation,
    installerSha256: "d".repeat(64),
    executableSha256: "e".repeat(64),
  }
  expect(verifyPublicAuthenticode(observation, f.mode.build.windowsSigning)).toEqual({ status: "UNSIGNED" })
  expect(verifyPublicSignaturePair(pair)).toEqual({
    status: "UNSIGNED_PREVIEW",
    policy: { provider: "unsigned-preview" },
    installer: { status: "UNSIGNED", sha256: pair.installerSha256 },
    executable: { status: "UNSIGNED", sha256: pair.executableSha256 },
  })
  for (const observation of [
    { Status: "HashMismatch", Publisher: null, Thumbprint: null },
    { Status: "UnknownError", Publisher: null, Thumbprint: null },
    { Status: "Valid", Publisher: "Some publisher", Thumbprint: "C".repeat(40) },
    { Status: "NotSigned", Publisher: "Some publisher", Thumbprint: null },
    { Status: "NotSigned", Publisher: null, Thumbprint: "C".repeat(40) },
    { Status: "NotSigned" },
    null,
  ]) {
    expect(() => verifyPublicSignaturePair({ ...pair, installer: observation })).toThrow()
    expect(() => verifyPublicSignaturePair({ ...pair, executable: observation })).toThrow()
  }
  expect(() => verifyPublicSignaturePair({ ...pair, executableSha256: "unknown" })).toThrow()
  f.mode.build.version = "0.1.0"
  f.mode.build.channel = "stable"
  f.mode.publicBuildInputsSha256 = publicReviewDigest(f.mode.build)
  expect(() => verifyPublicSignaturePair(pair)).toThrow()
})

test("public smoke cannot fabricate native qualification or be consumed as a public distribution", () => {
  const f = fixture()
  const base = qualificationReport({
    artifact: "fixture.deb",
    artifactSha256: "d".repeat(64),
    artifactBytes: 17,
    version: f.mode.build.version,
    checks: requiredQualificationChecks.map((id) => ({ id, status: "PASS", detail: "Synthetic test fixture" })),
    signature: { status: "NOT_TESTED", trust: "NOT_APPLICABLE" },
    inputsSha256: f.mode.releaseInputsSha256,
    sourceRevision: f.mode.build.sourceRevision,
  })
  expect(unqualifiedPublicSmokeReport({ base, mode: f.mode }).smokeResult).toBe("NOT_TESTED")
  const complete = {
    ...base,
    checks: [
      ...base.checks,
      ...["public-compiled-identity", "linux-sandbox-setup", "linux-renderer-sandbox", "uninstall"].map((id) => ({
        id,
        status: "PASS" as const,
        detail: "Synthetic test fixture",
      })),
    ],
  }
  const report = unqualifiedPublicSmokeReport({
    base: complete,
    mode: f.mode,
    compiledIdentity: verifyPublicPackagedIdentity(f.mode, f.archive),
  })
  expect(report.kind).toBe("unqualified-public-desktop-smoke")
  expect(report.result).toBe("UNQUALIFIED")
  expect(report.smokeResult).toBe("PASS")
  for (const id of ["public-compiled-identity", "linux-sandbox-setup", "linux-renderer-sandbox", "uninstall"]) {
    expect(
      unqualifiedPublicSmokeReport({
        base: { ...complete, checks: complete.checks.filter((check) => check.id !== id) },
        mode: f.mode,
        compiledIdentity: verifyPublicPackagedIdentity(f.mode, f.archive),
      }).smokeResult,
    ).toBe("NOT_TESTED")
  }
  expect(report.publication).toBe(false)
  expect(report.publicBuildInputsSha256).toBe(f.mode.publicBuildInputsSha256)
  expect(report.opticalFlickerMeasured).toBe(false)
  for (const id of unimplementedPublicChecks)
    expect(report.checks.find((check) => check.id === id)?.status).toBe("NOT_TESTED")
  expect(() => validateDistributionFacts(report)).toThrow()
  expect(() =>
    unqualifiedPublicSmokeReport({
      mode: f.mode,
      base: { ...base, checks: [...base.checks, { id: "platform-display", status: "PASS", detail: "invented" }] },
    }),
  ).toThrow("UNIMPLEMENTED_CHECK_OVERRIDE")
})

test("public installer smoke refuses local/self-hosted launch and escaped evidence paths", async () => {
  const f = await inputFixture()
  const owned = join(f.root, "owned")
  await mkdir(owned)
  const env = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_RUN_ID: "123",
    RUNNER_TEMP: f.root,
  }
  await expect(requireDisposablePublicRunner(env, owned, "linux")).resolves.toBeUndefined()
  for (const changed of [
    { ...env, CI: "false" },
    { ...env, RUNNER_ENVIRONMENT: "self-hosted" },
    { ...env, GITHUB_RUN_ID: "" },
  ])
    await expect(requireDisposablePublicRunner(changed, owned, "linux")).rejects.toThrow("DISPOSABLE_RUNNER")
  await expect(requireDisposablePublicRunner(env, f.root, "linux")).rejects.toThrow("OUTSIDE_RUNNER")
  if (process.platform !== "win32") {
    const link = join(f.root, "alias")
    await symlink(owned, link)
    await expect(requireDisposablePublicRunner(env, link, "linux")).rejects.toThrow("OUTSIDE_RUNNER")
  }
})

test.skipIf(process.platform !== "linux")(
  "actual public inspection CLI retains an unqualified receipt for failed inert package inspection",
  async () => {
    const f = await inputFixture()
    await writeFile(join(f.root, "fixture.deb"), "invalid inert archive, never executed")
    const child = spawn(
      process.execPath,
      [
        new URL("../../test/packaged-smoke.mjs", import.meta.url).pathname,
        ...f.args,
        ...f.publicArgs,
        "--inspection-only",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } },
    )
    let output = ""
    child.stdout.on("data", (bytes) => {
      output += bytes
    })
    child.stderr.on("data", (bytes) => {
      output += bytes
    })
    const code = await new Promise((resolve) => child.once("close", resolve))
    expect(code).toBe(1)
    const report = JSON.parse(await readFile(join(f.root, "receipt.json"), "utf8"))
    expect(report.kind).toBe("unqualified-public-desktop-smoke")
    expect(report.result).toBe("UNQUALIFIED")
    expect(report.smokeResult).toBe("FAIL")
    expect(report.publicBuildInputsSha256).toBe(f.mode.publicBuildInputsSha256)
    expect(report.checks.find((check: { id: string }) => check.id === "native-credential-storage").status).toBe(
      "NOT_TESTED",
    )
    expect(output).not.toContain(f.root)
  },
)
