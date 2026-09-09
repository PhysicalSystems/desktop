// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { collectPublicProducer } from "./public-collection-command"
import { publicNativeJobReceipt, publicNativeReceipt, publicReceiptBytes } from "./public-native-receipts"
import { simulatedPublicNativeFixture } from "./public-native-fixture"
import { verifyQualifiedBundle } from "./public-publisher"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(complete = true, unsigned = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "public-native-jobs-fixture-")))
  roots.push(root)
  const policy = unsigned ? { provider: "unsigned-preview" as const } : undefined
  const base = simulatedPublicNativeFixture("windows-x64", 0, complete, policy)
  const jobs: Record<string, { artifacts: string; receipts: string; expectedJobSha256: string }> = {}
  for (const platform of ["windows-x64", "linux-x64"] as const) {
    const jobRoot = join(root, "downloaded", platform === "windows-x64" ? "windows" : "linux")
    const artifacts = join(jobRoot, "artifacts")
    const receipts = join(jobRoot, "receipts")
    await mkdir(artifacts, { recursive: true })
    await mkdir(receipts)
    const inventory = []
    for (const index of platform === "windows-x64" ? [0] : [0, 1]) {
      const f = simulatedPublicNativeFixture(platform, index, complete, policy)
      await writeFile(join(artifacts, f.artifact.name), f.bytes)
      const smoke = publicReceiptBytes(f.report)
      const native = publicReceiptBytes(publicNativeReceipt(f))
      await writeFile(join(receipts, `${smoke.sha256}.json`), smoke.bytes)
      await writeFile(join(receipts, `${native.sha256}.json`), native.bytes)
      inventory.push({
        name: f.artifact.name,
        bytes: f.artifact.bytes,
        sha256: f.artifact.sha256,
        smokeSha256: smoke.sha256,
        nativeSha256: native.sha256,
      })
    }
    const f = simulatedPublicNativeFixture(platform, 0, complete, policy)
    const job = publicReceiptBytes(publicNativeJobReceipt({ ...f, platform, artifacts: inventory }))
    await writeFile(join(receipts, "native-job.json"), job.bytes)
    jobs[platform] = { artifacts, receipts, expectedJobSha256: job.sha256 }
  }
  const input = {
    env: base.env,
    publicBuild: base.build,
    expectedPublicBuildSha256: base.publicBuildInputsSha256,
    expectedInputsSha256: base.build.releaseInputsSha256,
    windows: jobs["windows-x64"]!,
    linux: jobs["linux-x64"]!,
    staging: join(root, "staging"),
    output: join(root, "qualified"),
  }
  return { root, input }
}

test("trusted separate native job outputs reach the real strict collector without rebuilding exact bytes", async () => {
  const f = await fixture()
  const result = await collectPublicProducer(f.input)
  expect(
    await verifyQualifiedBundle({
      directory: f.input.output,
      expectedSha256: result.sha256,
      sourceRevision: f.input.env.GITHUB_SHA,
    }),
  ).toEqual(result.record)
  expect(result.record.facts.assets).toHaveLength(3)
  expect(await readdir(f.input.output)).toHaveLength(9)
  const plan = JSON.parse(await readFile(`${f.input.staging}.plan.json`, "utf8"))
  expect(plan.artifacts).toHaveLength(3)
  expect(plan.runId).toBe(f.input.env.GITHUB_RUN_ID)
  await expect(collectPublicProducer(f.input)).rejects.toThrow()
})

test("real partial observations remain incomplete and cannot emit a qualified bundle", async () => {
  const f = await fixture(false)
  await expect(collectPublicProducer(f.input)).rejects.toThrow("PUBLIC_COLLECTION_EVIDENCE_INVALID")
  expect(await readdir(f.root)).not.toContain("qualified")
})

test("unsigned preview traverses both trusted native-job anchors and preserves all native requirements", async () => {
  const f = await fixture(true, true)
  const result = await collectPublicProducer(f.input)
  expect(result.record.facts.windowsSigning.status).toBe("unsigned-preview")
  expect(result.record.facts.assets).toHaveLength(3)
  expect(
    await verifyQualifiedBundle({
      directory: f.input.output,
      expectedSha256: result.sha256,
      sourceRevision: f.input.env.GITHUB_SHA,
    }),
  ).toEqual(result.record)
  const partial = await fixture(false, true)
  await expect(collectPublicProducer(partial.input)).rejects.toThrow("PUBLIC_COLLECTION_EVIDENCE_INVALID")
  expect(await readdir(partial.root)).not.toContain("qualified")
  const changed = await fixture(true, true)
  changed.input.windows.expectedJobSha256 = "0".repeat(64)
  await expect(collectPublicProducer(changed.input)).rejects.toThrow()
  expect(await readdir(changed.root)).not.toContain("qualified")
})

test("the real workflow CLI collects complete simulated job evidence and exports only the qualification anchor", async () => {
  const f = await fixture()
  const build = join(f.root, "public-build-inputs.json")
  const output = join(f.root, "github-output")
  const summary = join(f.root, "summary.md")
  await writeFile(build, publicReceiptBytes(f.input.publicBuild).bytes)
  const script = fileURLToPath(new URL("../../../../script/desktop-public-producer.ts", import.meta.url))
  const result = spawnSync(process.execPath, [script, "collect"], {
    cwd: f.root,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...f.input.env,
      PATH: process.env.PATH,
      PUBLIC_DOWNLOADED_DIRECTORY: join(f.root, "downloaded"),
      PUBLIC_BUILD_INPUTS: build,
      EXPECTED_PUBLIC_BUILD_SHA256: f.input.expectedPublicBuildSha256,
      EXPECTED_RELEASE_INPUTS_SHA256: f.input.expectedInputsSha256,
      EXPECTED_WINDOWS_JOB_SHA256: f.input.windows.expectedJobSha256,
      EXPECTED_LINUX_JOB_SHA256: f.input.linux.expectedJobSha256,
      PUBLIC_COLLECTION_STAGING: f.input.staging,
      PUBLIC_QUALIFIED_DIRECTORY: f.input.output,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    },
  })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(await readFile(output, "utf8")).toMatch(/^qualification_sha256=[a-f0-9]{64}\n$/)
  expect(await readFile(summary, "utf8")).toContain("protected approval")
  expect(result.stdout).not.toContain(f.root)
})

test("rehashed downloads cannot replace a separately trusted native-job anchor or run attempt", async () => {
  for (const changed of ["sha", "run", "artifact", "extra", "symlink"] as const) {
    const f = await fixture()
    if (changed === "sha") f.input.windows.expectedJobSha256 = "0".repeat(64)
    if (changed === "run") f.input.env.GITHUB_RUN_ATTEMPT = "2"
    if (changed === "artifact") {
      const file = (await readdir(f.input.windows.artifacts))[0]!
      await writeFile(join(f.input.windows.artifacts, file), "changed installer bytes")
    }
    if (changed === "extra") await writeFile(join(f.input.linux.receipts, "unexpected.json"), "{}")
    if (changed === "symlink") {
      const file = join(f.input.windows.receipts, "native-job.json")
      const bytes = await readFile(file)
      await rm(file)
      await writeFile(join(f.root, "outside.json"), bytes)
      await symlink(join(f.root, "outside.json"), file)
    }
    await expect(collectPublicProducer(f.input)).rejects.toThrow()
    expect(await readdir(f.root)).not.toContain("qualified")
  }
})
