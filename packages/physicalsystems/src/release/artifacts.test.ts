// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  artifactDigest,
  candidateDownloads,
  candidateNames,
  createInventory,
  verifyInventory,
  verifyPlatformReport,
  verifyQualification,
} from "./artifacts"
import type {
  CandidateArtifact,
  CandidateInventory,
  CandidatePlatform,
  PlatformReport,
  Qualification,
} from "./artifacts"
import { requiredQualificationChecks } from "./qualification"

const roots: string[] = []
const inputs = {
  version: "0.1.0-beta.1",
  channel: "preview" as const,
  sha256: "a".repeat(64),
  source: {
    revision: "b".repeat(40),
    tree: "c".repeat(40),
    repository: "PhysicalSystems/desktop",
    upstream: { repository: "https://github.com/anomalyco/opencode", revision: "d".repeat(40) },
  },
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(platform: CandidatePlatform = "linux-x64") {
  const root = await mkdtemp(join(tmpdir(), "ps-candidate-artifacts-"))
  roots.push(root)
  for (const entry of candidateNames(inputs.version, platform))
    await writeFile(join(root, entry.name), `fixture package bytes: ${entry.format}`)
  const inventory = await createInventory(root, inputs, platform)
  await writeFile(join(root, "artifacts.json"), JSON.stringify(inventory))
  return { root, inventory }
}

function receipt(artifact: CandidateArtifact, inventory: CandidateInventory): Qualification {
  return {
    schemaVersion: 1,
    artifact: { name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes },
    inputsSha256: inventory.inputsSha256,
    sourceRevision: inventory.sourceRevision,
    version: inventory.version,
    platform: inventory.platform,
    simulationOnly: true,
    opticalFlickerMeasured: false,
    deviceConnectionsAllowed: false,
    payload: { sha256: "e".repeat(64), executableSha256: "f".repeat(64) },
    signature:
      inventory.platform === "windows-x64"
        ? { status: "BLOCKED", trust: "UNSIGNED_INTERNAL_CANDIDATE" }
        : { status: "NOT_TESTED", trust: "NOT_APPLICABLE_TO_LINUX_PACKAGE" },
    publicDistribution: { status: "BLOCKED", reason: "Internal simulation candidate" },
    result: "PASS",
    checks: [...requiredQualificationChecks, ...(artifact.format === "nsis" ? ["uninstall"] : [])].map((id) => ({
      id,
      status: "PASS",
    })),
  }
}

function platformReport(inventory: CandidateInventory): PlatformReport {
  return {
    schemaVersion: 1,
    inputsSha256: inputs.sha256,
    inventory,
    publication: false,
    result: "PASS",
    checks: inventory.files.map((file) => ({ artifact: file.name, status: "PASS" })),
    qualifications: inventory.files.map((file) => receipt(file, inventory)),
  }
}

test("inventory binds to exact installer bytes, including after a saved manifest was created", async () => {
  const { root, inventory } = await fixture()
  expect(await verifyInventory(root, inputs)).toEqual(inventory)
  await writeFile(join(root, inventory.files[0].name), "changed installer")
  await expect(verifyInventory(root, inputs)).rejects.toThrow("does not match")
})

test("forged hashes and inventories from another source cannot qualify the same directory", async () => {
  const { root, inventory } = await fixture()
  inventory.files[0].sha256 = "0".repeat(64)
  await writeFile(join(root, "artifacts.json"), JSON.stringify(inventory))
  await expect(verifyInventory(root, inputs)).rejects.toThrow("does not match")
  await expect(verifyInventory(root, { ...inputs, sha256: "1".repeat(64) })).rejects.toThrow("does not match")
})

test.skipIf(process.platform === "win32")("symlinked installer bytes are refused", async () => {
  const { root, inventory } = await fixture()
  const file = join(root, inventory.files[0].name)
  await rm(file)
  await symlink(join(root, inventory.files[1].name), file)
  await expect(artifactDigest(file)).rejects.toThrow("regular artifact")
})

test("stale installer names and missing required formats fail before qualification", async () => {
  const { root } = await fixture()
  await writeFile(join(root, "stale.EXE"), "previous build")
  await expect(createInventory(root, inputs, "linux-x64")).rejects.toThrow("Unexpected installer")
  await rm(join(root, "stale.EXE"))
  await rm(join(root, candidateNames(inputs.version, "linux-x64")[1].name))
  await expect(createInventory(root, inputs, "linux-x64")).rejects.toThrow()
})

test("qualification must match artifact bytes, embedded source and platform", async () => {
  const { inventory } = await fixture()
  const artifact = inventory.files[0]
  const valid = receipt(artifact, inventory)
  expect(verifyQualification(artifact, inventory, valid)).toBe(valid)
  for (const invalid of [
    { ...valid, artifact: { ...valid.artifact, sha256: "0".repeat(64) } },
    { ...valid, artifact: { ...valid.artifact, bytes: artifact.bytes + 1 } },
    { ...valid, inputsSha256: "1".repeat(64) },
    { ...valid, sourceRevision: "2".repeat(40) },
    { ...valid, platform: "windows-x64" as const },
    { ...valid, payload: undefined },
  ])
    expect(() => verifyQualification(artifact, inventory, invalid)).toThrow()
})

test("a PASS label cannot hide omitted, duplicate, skipped or failed checks", async () => {
  const { inventory } = await fixture()
  const artifact = inventory.files[0]
  const valid = receipt(artifact, inventory)
  expect(() =>
    verifyQualification(artifact, inventory, { ...valid, checks: [...valid.checks, valid.checks[0]] }),
  ).toThrow("Duplicate")
  for (const id of requiredQualificationChecks) {
    expect(() =>
      verifyQualification(artifact, inventory, { ...valid, checks: valid.checks.filter((check) => check.id !== id) }),
    ).toThrow("incomplete")
    expect(() =>
      verifyQualification(artifact, inventory, {
        ...valid,
        checks: valid.checks.map((check) => (check.id === id ? { ...check, status: "NOT_TESTED" } : check)),
      }),
    ).toThrow("incomplete")
  }
  expect(() =>
    verifyQualification(artifact, inventory, {
      ...valid,
      checks: [...valid.checks, { id: "cleanup-extra", status: "FAIL" }],
    }),
  ).toThrow("incomplete")
})

test("Windows receipts require uninstallation and reject signature failure", async () => {
  const { inventory } = await fixture("windows-x64")
  const artifact = inventory.files[0]
  const valid = receipt(artifact, inventory)
  expect(verifyQualification(artifact, inventory, valid)).toBe(valid)
  expect(() =>
    verifyQualification(artifact, inventory, {
      ...valid,
      checks: valid.checks.filter((check) => check.id !== "uninstall"),
    }),
  ).toThrow("incomplete")
  expect(() =>
    verifyQualification(artifact, inventory, { ...valid, signature: { status: "FAIL", trust: "HASH_MISMATCH" } }),
  ).toThrow("signature")
  expect(() =>
    verifyQualification(artifact, inventory, { ...valid, signature: { status: "NOT_TESTED", trust: "NOT_TESTED" } }),
  ).toThrow("signature")
  expect(() =>
    verifyQualification(artifact, inventory, {
      ...valid,
      signature: { status: "PASS", trust: "WINDOWS_AUTHENTICODE_VALID" },
    }),
  ).toThrow("signature")
})

test("download metadata rejects duplicate formats, mixed inputs and duplicate platforms", async () => {
  const { inventory } = await fixture()
  expect(candidateDownloads(inputs, [inventory]).artifacts).toHaveLength(2)
  expect(() => candidateDownloads(inputs, [{ ...inventory, files: [inventory.files[0], inventory.files[0]] }])).toThrow(
    "Unexpected",
  )
  expect(() => candidateDownloads(inputs, [{ ...inventory, sourceRevision: "9".repeat(40) }])).toThrow("Mixed")
  expect(() => candidateDownloads(inputs, [{ ...inventory, inputsSha256: "8".repeat(64) }])).toThrow("Mixed")
  expect(() => candidateDownloads(inputs, [inventory, inventory])).toThrow("Duplicate")
  expect(() =>
    candidateDownloads(inputs, [
      { ...inventory, files: inventory.files.map((file) => ({ ...file, sha512: "missing" })) },
    ]),
  ).toThrow("Unexpected")
})

test("aggregate review revalidates embedded receipts rather than trusting a platform PASS label", async () => {
  const { inventory } = await fixture()
  const report = platformReport(inventory)
  expect(verifyPlatformReport(inputs, report)).toBe(report)
  expect(() => verifyPlatformReport(inputs, { ...report, qualifications: [] })).toThrow("receipt")
  expect(() =>
    verifyPlatformReport(inputs, { ...report, qualifications: [report.qualifications[0], report.qualifications[0]] }),
  ).toThrow("receipt")
  expect(() => verifyPlatformReport(inputs, { ...report, checks: [] })).toThrow("receipt")
  expect(() =>
    verifyPlatformReport(inputs, {
      ...report,
      qualifications: report.qualifications.map((item) => ({
        ...item,
        checks: item.checks.filter((check) => check.id !== "launch"),
      })),
    }),
  ).toThrow("incomplete")
})
