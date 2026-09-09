// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { collectPublicDistribution } from "./public-collector"
import type { PublicCollectionPlan, PublicNativeReceipt } from "./public-collector"
import type { PublicBuildInputs } from "./public-build"
import { desktopIdentity } from "./identity"
import { candidateNames } from "./artifacts"
import { publicReviewDigest } from "./public-downloads"
import { qualificationReport, requiredQualificationChecks } from "./qualification"
import {
  unimplementedPublicChecks,
  unqualifiedPublicSmokeReport,
  verifyPublicSignaturePair,
} from "./public-qualification"
import { verifyQualifiedBundle } from "./public-publisher"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const fields = (value: unknown) => value as Record<string, unknown>
const checks = (record: Record<string, unknown>) => record.checks as Record<string, unknown>[]

async function fixture(unsigned = false) {
  // All payloads, signatures and native PASS records below are explicit simulated
  // collector test fixtures. These tests never sign, install or launch an app.
  const root = await realpath(await mkdtemp(join(tmpdir(), "ps-collector-fixture-")))
  roots.push(root)
  const evidence = join(root, "evidence")
  await mkdir(evidence)
  const build: PublicBuildInputs = {
    schemaVersion: 1,
    kind: "public-desktop-build",
    sourceRevision: "a".repeat(40),
    releaseInputsSha256: "b".repeat(64),
    version: "0.1.0-beta.1",
    channel: "preview",
    identity: desktopIdentity("public"),
    publication: false,
    windowsSigning: unsigned
      ? { provider: "unsigned-preview" }
      : {
          provider: "pfx",
          publisher: "SIMULATED COLLECTOR FIXTURE ONLY",
          certificateThumbprint: "C".repeat(40),
        },
  }
  const mode = {
    build,
    publicBuildInputsSha256: publicReviewDigest(build),
    releaseInputsSha256: build.releaseInputsSha256,
  }
  const plan: PublicCollectionPlan = {
    schemaVersion: 1,
    kind: "public-desktop-collection-plan",
    runId: "12345",
    runAttempt: 1,
    sourceRevision: build.sourceRevision,
    releaseInputsSha256: build.releaseInputsSha256,
    publicBuildInputsSha256: mode.publicBuildInputsSha256,
    artifacts: [],
  }
  for (const item of [...candidateNames(build.version, "windows-x64"), ...candidateNames(build.version, "linux-x64")]) {
    const bytes = `SIMULATED COLLECTOR FIXTURE, NOT AN INSTALLER: ${item.name}`
    const artifact = { name: item.name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }
    await writeFile(join(evidence, item.name), bytes)
    const windows = item.format === "nsis"
    const extra = windows
      ? [unsigned ? "public-unsigned-preview" : "public-signing", "uninstall", "native-reinstall-probe"]
      : [
          "linux-sandbox-setup",
          "linux-renderer-sandbox",
          "linux-temporary-cleanup",
          "native-secret-service-cleanup",
          ...(item.format === "deb"
            ? ["uninstall", "native-reinstall-probe"]
            : ["appimage-launcher", "linux-sandbox-cleanup"]),
        ]
    const observed = unsigned
      ? { Status: "NotSigned", Publisher: null, Thumbprint: null }
      : { Status: "Valid", Publisher: "SIMULATED COLLECTOR FIXTURE ONLY", Thumbprint: "C".repeat(40) }
    const signing = windows
      ? verifyPublicSignaturePair({
          installer: observed,
          executable: observed,
          mode,
          installerSha256: artifact.sha256,
          executableSha256: "d".repeat(64),
        })
      : undefined
    const base = qualificationReport({
      artifact: artifact.name,
      artifactBytes: artifact.bytes,
      artifactSha256: artifact.sha256,
      version: build.version,
      checks: [...requiredQualificationChecks, "public-compiled-identity", "native-v2-credential-probe", ...extra].map(
        (id) => ({
          id,
          status: "PASS",
          detail: "SIMULATED COLLECTOR FIXTURE ONLY",
        }),
      ),
      signature: windows
        ? unsigned
          ? { status: "UNSIGNED", trust: "WINDOWS_AUTHENTICODE_UNSIGNED" }
          : { status: "PASS", trust: "WINDOWS_AUTHENTICODE_VALID", signerThumbprint: "C".repeat(40) }
        : { status: "NOT_TESTED", trust: "NOT_APPLICABLE_TO_LINUX_PACKAGE" },
      payload: { sha256: "e".repeat(64), executableSha256: "d".repeat(64) },
      inputsSha256: build.releaseInputsSha256,
      sourceRevision: build.sourceRevision,
    })
    const smoke = unqualifiedPublicSmokeReport({
      base: { ...base, platform: windows ? "windows-x64" : "linux-x64" },
      mode,
      compiledIdentity: {
        identity: "public",
        publicBuildInputsSha256: mode.publicBuildInputsSha256,
        mainSha256: "f".repeat(64),
      },
      signing,
    })
    const native: PublicNativeReceipt = {
      schemaVersion: 1,
      kind: "public-desktop-native-qualification",
      runId: plan.runId,
      runAttempt: plan.runAttempt,
      sourceRevision: plan.sourceRevision,
      releaseInputsSha256: plan.releaseInputsSha256,
      publicBuildInputsSha256: plan.publicBuildInputsSha256,
      artifact,
      identity: desktopIdentity("public"),
      platform: windows ? "windows-x64" : "linux-x64",
      checks: unimplementedPublicChecks.map((id) => ({ id, status: "PASS" })),
    }
    const smokeSha256 = hash(serialize(smoke)),
      nativeSha256 = hash(serialize(native))
    await writeFile(join(evidence, `${smokeSha256}.json`), serialize(smoke))
    await writeFile(join(evidence, `${nativeSha256}.json`), serialize(native))
    plan.artifacts.push({ ...artifact, smokeSha256, nativeSha256 })
  }
  const input = () => ({
    plan,
    expectedPlanSha256: publicReviewDigest(plan),
    publicBuild: build,
    expectedPublicBuildSha256: mode.publicBuildInputsSha256,
    expectedInputsSha256: build.releaseInputsSha256,
    sourceRevision: build.sourceRevision,
    runId: plan.runId,
    runAttempt: plan.runAttempt,
    evidence,
    output: join(root, "collected"),
  })
  const edit = async (
    kind: "smokeSha256" | "nativeSha256",
    change: (record: Record<string, unknown>) => void,
    index = 0,
  ) => {
    const artifact = plan.artifacts[index]
    const file = join(evidence, `${artifact[kind]}.json`)
    const value = JSON.parse(await readFile(file, "utf8"))
    change(value)
    await rm(file)
    artifact[kind] = hash(serialize(value))
    await writeFile(join(evidence, `${artifact[kind]}.json`), serialize(value))
  }
  return { root, evidence, build, plan, input, edit }
}

test("collector creates the exact existing publisher bundle only from complete simulated evidence", async () => {
  const f = await fixture()
  await f.edit("smokeSha256", (record) => {
    checks(record)[0].detail = "PRIVATE-DETAIL-MUST-NOT-LEAVE"
  })
  const result = await collectPublicDistribution(f.input())
  expect(
    await verifyQualifiedBundle({
      directory: f.input().output,
      expectedSha256: result.sha256,
      sourceRevision: f.build.sourceRevision,
    }),
  ).toEqual(result.record)
  expect(result.record.facts.assets).toHaveLength(3)
  expect(await readdir(f.input().output)).toHaveLength(9)
  for (const file of await readdir(f.input().output)) {
    expect(
      file === "qualified-distribution.json" ||
        /^[a-f0-9]{64}\.json$/.test(file) ||
        f.plan.artifacts.some((artifact) => artifact.name === file),
    ).toBe(true)
    if (file.endsWith(".json"))
      expect(await readFile(join(f.input().output, file), "utf8")).not.toContain("PRIVATE-DETAIL-MUST-NOT-LEAVE")
  }
  await expect(collectPublicDistribution(f.input())).rejects.toThrow()
})

test("collector carries explicit unsigned preview observations without inventing a signed publisher", async () => {
  const f = await fixture(true)
  const result = await collectPublicDistribution(f.input())
  expect(result.record.facts.windowsSigning).toEqual({
    status: "unsigned-preview",
    installerSha256: f.plan.artifacts[0].sha256,
    executableSha256: "d".repeat(64),
    verificationReportSha256: result.record.facts.windowsSigning.verificationReportSha256,
  })
  const receipt = JSON.parse(
    await readFile(
      join(f.input().output, `${result.record.facts.windowsSigning.verificationReportSha256}.json`),
      "utf8",
    ),
  )
  expect(receipt.status).toBe("UNSIGNED_PREVIEW")
  expect(receipt.installer).toEqual({ status: "UNSIGNED", sha256: f.plan.artifacts[0].sha256 })
  expect(JSON.stringify(receipt)).not.toContain("publisher")
  expect(result.record.facts.assets).toHaveLength(3)
  for (const asset of result.record.facts.assets) {
    const report = JSON.parse(
      await readFile(join(f.input().output, `${asset.qualification.reportSha256}.json`), "utf8"),
    )
    expect(report.smokeChecks["public-signing"]).toBeUndefined()
    if (asset.name.endsWith(".exe")) expect(report.smokeChecks["public-unsigned-preview"]).toBe("PASS")
  }
})

test("unsigned collection still requires exact unsigned observations and every native requirement", async () => {
  for (const change of [
    (record: Record<string, unknown>) => {
      delete record.signing
    },
    (record: Record<string, unknown>) => {
      fields(record.signing).status = "PASS"
    },
    (record: Record<string, unknown>) => {
      fields(fields(record.signing).installer).status = "PASS"
    },
    (record: Record<string, unknown>) => {
      fields(fields(record.signing).installer).publisher = "Invented"
    },
    (record: Record<string, unknown>) => {
      fields(fields(record.signing).executable).sha256 = "0".repeat(64)
    },
    (record: Record<string, unknown>) => {
      fields(record.signature).signerThumbprint = "C".repeat(40)
    },
    (record: Record<string, unknown>) => {
      fields(record.signature).status = "PASS"
    },
    (record: Record<string, unknown>) => {
      checks(record).find((check) => check.id === "public-unsigned-preview")!.status = "NOT_TESTED"
    },
    (record: Record<string, unknown>) => {
      checks(record).find((check) => check.id === "public-unsigned-preview")!.id = "public-signing"
    },
    (record: Record<string, unknown>) => {
      checks(record).push({ id: "public-signing", status: "PASS" })
    },
  ]) {
    const f = await fixture(true)
    await f.edit("smokeSha256", change)
    await expect(collectPublicDistribution(f.input())).rejects.toThrow("PUBLIC_COLLECTION_EVIDENCE_INVALID")
    expect(await readdir(f.root)).not.toContain("collected")
  }
  for (const id of unimplementedPublicChecks) {
    const f = await fixture(true)
    await f.edit("nativeSha256", (record) => {
      record.checks = checks(record).filter((check) => check.id !== id)
    })
    await expect(collectPublicDistribution(f.input())).rejects.toThrow("PUBLIC_COLLECTION_EVIDENCE_INVALID")
  }
})

test("current unqualified smoke cannot substitute for absent, skipped or duplicated native checks", async () => {
  const alone = await fixture()
  for (const artifact of alone.plan.artifacts) {
    await rm(join(alone.evidence, `${artifact.nativeSha256}.json`))
    artifact.nativeSha256 = artifact.smokeSha256
  }
  await expect(collectPublicDistribution(alone.input())).rejects.toThrow()
  expect(await readdir(alone.root)).not.toContain("collected")
  for (const change of [
    (record: Record<string, unknown>) => {
      record.kind = "unqualified-public-desktop-smoke"
    },
    (record: Record<string, unknown>) => {
      checks(record).pop()
    },
    (record: Record<string, unknown>) => {
      checks(record).push(checks(record)[0])
    },
    (record: Record<string, unknown>) => {
      checks(record)[0].status = "NOT_TESTED"
    },
    (record: Record<string, unknown>) => {
      checks(record)[0].status = "FAIL"
    },
    (record: Record<string, unknown>) => {
      checks(record)[0].status = "BLOCKED"
    },
    (record: Record<string, unknown>) => {
      checks(record)[0].evidence = "untrusted extra field"
    },
  ]) {
    const f = await fixture()
    await f.edit("nativeSha256", change)
    await expect(collectPublicDistribution(f.input())).rejects.toThrow()
    expect(await readdir(f.root)).not.toContain("collected")
  }
})

test("the current producer's native probe and every owned Linux cleanup must pass before collection", async () => {
  for (const index of [0, 1, 2]) {
    const required = [
      "native-v2-credential-probe",
      ...(index < 2 ? ["native-reinstall-probe"] : []),
      ...(index === 0 ? [] : ["native-secret-service-cleanup", "linux-temporary-cleanup"]),
    ]
    for (const id of required) {
      for (const status of [undefined, "FAIL", "BLOCKED", "NOT_TESTED", "RETAINED"]) {
        const f = await fixture()
        await f.edit(
          "smokeSha256",
          (record) => {
            if (status === undefined) record.checks = checks(record).filter((check) => check.id !== id)
            else checks(record).find((check) => check.id === id)!.status = status
          },
          index,
        )
        await expect(collectPublicDistribution(f.input())).rejects.toThrow("PUBLIC_COLLECTION_EVIDENCE_INVALID")
        expect(await readdir(f.root)).not.toContain("collected")
      }
    }
  }
})

test("passing auxiliary smoke probes cannot replace any of the eight separate public native checks", async () => {
  for (const id of unimplementedPublicChecks) {
    const f = await fixture()
    // The fixture's current-producer auxiliary probe and cleanup checks all PASS.
    // Removing any separately anchored native requirement must still reject it.
    await f.edit("nativeSha256", (record) => {
      record.checks = checks(record).filter((check) => check.id !== id)
    })
    await expect(collectPublicDistribution(f.input())).rejects.toThrow("PUBLIC_COLLECTION_EVIDENCE_INVALID")
    expect(await readdir(f.root)).not.toContain("collected")
  }
  const substituted = await fixture()
  await substituted.edit("nativeSha256", (record) => {
    record.checks = [
      { id: "native-v2-credential-probe", status: "PASS" },
      { id: "native-secret-service-cleanup", status: "PASS" },
      { id: "native-reinstall-probe", status: "PASS" },
    ]
  })
  await expect(collectPublicDistribution(substituted.input())).rejects.toThrow("PUBLIC_COLLECTION_EVIDENCE_INVALID")
})

test("optional browser-only handoff is accepted as auxiliary evidence but never replaces provider qualification", async () => {
  for (const status of ["PASS", "NOT_TESTED", "FAIL", "BLOCKED"] as const) {
    const f = await fixture()
    await f.edit("smokeSha256", (record) => {
      checks(record).push({ id: "native-browser-handoff-probe", status, detail: "SIMULATED LOOPBACK FIXTURE ONLY" })
    })
    if (status === "FAIL" || status === "BLOCKED") {
      await expect(collectPublicDistribution(f.input())).rejects.toThrow("PUBLIC_COLLECTION_EVIDENCE_INVALID")
      expect(await readdir(f.root)).not.toContain("collected")
      continue
    }
    expect((await collectPublicDistribution(f.input())).record.facts.assets).toHaveLength(3)
  }
  const substituted = await fixture()
  await substituted.edit("smokeSha256", (record) => {
    checks(record).push({ id: "native-browser-handoff-probe", status: "PASS", detail: "SIMULATED FIXTURE ONLY" })
  })
  await substituted.edit("nativeSha256", (record) => {
    checks(record).find((check) => check.id === "provider-browser-sign-in")!.status = "NOT_TESTED"
  })
  await expect(collectPublicDistribution(substituted.input())).rejects.toThrow("PUBLIC_COLLECTION_EVIDENCE_INVALID")
  expect(await readdir(substituted.root)).not.toContain("collected")
})

test("independent anchors, all formats and native run/source/input/identity bindings are mandatory", async () => {
  const f = await fixture()
  for (const overrides of [
    { expectedPlanSha256: "0".repeat(64) },
    { expectedPublicBuildSha256: "0".repeat(64) },
    { expectedInputsSha256: "0".repeat(64) },
    { sourceRevision: "0".repeat(40) },
    { runId: "54321" },
    { runAttempt: 2 },
  ])
    await expect(collectPublicDistribution({ ...f.input(), ...overrides })).rejects.toThrow()
  for (const field of [
    "runId",
    "runAttempt",
    "sourceRevision",
    "releaseInputsSha256",
    "publicBuildInputsSha256",
    "platform",
    "identity",
    "artifact",
  ] as const) {
    const f = await fixture()
    await f.edit("nativeSha256", (record) => {
      record[field] = field === "identity" ? desktopIdentity("candidate") : "mismatched"
    })
    await expect(collectPublicDistribution(f.input())).rejects.toThrow()
  }
  for (const change of [
    (plan: PublicCollectionPlan) => plan.artifacts.pop(),
    (plan: PublicCollectionPlan) => {
      plan.artifacts[1] = plan.artifacts[0]
    },
  ]) {
    const f = await fixture()
    change(f.plan)
    await expect(collectPublicDistribution(f.input())).rejects.toThrow()
  }
})

test("public compiled identity, exact signatures and actual smoke PASS remain required", async () => {
  for (const change of [
    (record: Record<string, unknown>) => {
      record.identity = desktopIdentity("candidate")
    },
    (record: Record<string, unknown>) => {
      fields(record.compiledIdentity).identity = "candidate"
    },
    (record: Record<string, unknown>) => {
      record.smokeResult = "NOT_TESTED"
    },
    (record: Record<string, unknown>) => {
      checks(record)[0].status = "FAIL"
    },
    (record: Record<string, unknown>) => {
      fields(fields(record.signing).installer).certificateThumbprint = "D".repeat(40)
    },
    (record: Record<string, unknown>) => {
      fields(fields(record.signing).executable).certificateThumbprint = "D".repeat(40)
    },
    (record: Record<string, unknown>) => {
      fields(fields(record.signing).executable).sha256 = "0".repeat(64)
    },
    (record: Record<string, unknown>) => {
      fields(fields(record.signing).installer).publisher = "Wrong Publisher"
    },
    (record: Record<string, unknown>) => {
      record.privateProfile = "/private/profile"
    },
  ]) {
    const f = await fixture()
    await f.edit("smokeSha256", change)
    await expect(collectPublicDistribution(f.input())).rejects.toThrow()
  }
})

test("changed bytes, unknown files and symlinks cannot enter the public bundle", async () => {
  for (const name of ["auth.json", "application.log", "runtime-attach.json"]) {
    const f = await fixture()
    await writeFile(join(f.evidence, name), "PRIVATE TRAP")
    await expect(collectPublicDistribution(f.input())).rejects.toThrow()
  }
  const f = await fixture()
  await writeFile(join(f.evidence, f.plan.artifacts[0].name), "CHANGED INSTALLER")
  await expect(collectPublicDistribution(f.input())).rejects.toThrow()
  const changed = await fixture()
  await writeFile(join(changed.evidence, `${changed.plan.artifacts[0].nativeSha256}.json`), "{}")
  await expect(collectPublicDistribution(changed.input())).rejects.toThrow()
})

test.skipIf(process.platform === "win32")("collector rejects evidence roots and files that are symlinks", async () => {
  const f = await fixture()
  const alias = join(f.root, "alias")
  await symlink(f.evidence, alias)
  await expect(collectPublicDistribution({ ...f.input(), evidence: alias })).rejects.toThrow()
  const file = join(f.evidence, `${f.plan.artifacts[0].nativeSha256}.json`)
  const outside = join(f.root, "receipt.json")
  await writeFile(outside, await readFile(file))
  await rm(file)
  await symlink(outside, file)
  await expect(collectPublicDistribution(f.input())).rejects.toThrow()
})

test("real collector CLI emits a digest for simulated evidence and fails closed for missing anchors", async () => {
  const f = await fixture()
  const planFile = join(f.root, "plan.json"),
    publicFile = join(f.root, "public.json")
  await writeFile(planFile, serialize(f.plan))
  await writeFile(publicFile, serialize(f.build))
  const args = [
    resolve(import.meta.dir, "../../../../script/desktop-public-collect.ts"),
    "--plan",
    planFile,
    "--expected-plan-sha256",
    publicReviewDigest(f.plan),
    "--public-inputs",
    publicFile,
    "--expected-public-build-sha256",
    f.input().expectedPublicBuildSha256,
    "--expected-inputs-sha256",
    f.build.releaseInputsSha256,
    "--source-sha",
    f.build.sourceRevision,
    "--run-id",
    f.plan.runId,
    "--run-attempt",
    "1",
    "--evidence",
    f.evidence,
    "--output",
    f.input().output,
  ]
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: f.root }
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 10000 })
  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/Qualification SHA-256: [a-f0-9]{64}/)
  const failed = spawnSync(process.execPath, args.slice(0, -2), { env, encoding: "utf8", timeout: 10000 })
  expect(failed.status).toBe(1)
  expect(failed.stderr).toContain("PUBLIC_COLLECTION_FAILED")
  expect(failed.stderr).not.toContain(f.root)
})
