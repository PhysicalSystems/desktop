// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { preparePublicUpgradeInputs, loadPublicUpgradeInputs } from "./public-upgrade-inputs"
import { freezePublicProducerPolicy } from "./public-producer"
import { publicReviewDigest } from "./public-downloads"

const directories: string[] = []
const history = { complete: true as const, versions: [] as string[] }
const policy = JSON.parse(await readFile(new URL("../../../../release/desktop.json", import.meta.url), "utf8"))

afterAll(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function commit(root: string) {
  git(root, "add", ".")
  git(
    root,
    "-c",
    "user.name=Release fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "test: release fixture",
  )
}

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "physical-release-inputs-"))
  directories.push(root)
  git(root, "init", "--quiet")
  await writeFile(path.join(root, "LICENSE"), "Fixture license\n")
  commit(root)
  const fixturePolicy = structuredClone(policy)
  fixturePolicy.upstream.revision = git(root, "rev-parse", "HEAD")
  const artifacts = {
    "operator-service.mjs": "export const simulationOnly = true\n",
    LICENSE: "Operator fixture license\n",
    NOTICE: "Operator fixture notice\n",
    "skills/inspect-workcell/SKILL.md": "# Inspect\n",
    "skills/inspect-workcell/physicalsystems.binding.json": "{}\n",
    "skills/transfer-container/SKILL.md": "# Transfer\n",
    "skills/transfer-container/physicalsystems.binding.json": "{}\n",
  }
  const manifest = {
    schemaVersion: 1,
    repository: "https://github.com/PhysicalSystems/physicalsystems",
    revision: "a".repeat(40),
    dirty: false,
    sourceFiles: { "packages/operator-service/src/index.js": digest("fixture source") },
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, digest(bytes)])),
  }
  const files: Record<string, string | Buffer> = {
    "release/desktop.json": JSON.stringify(fixturePolicy),
    "package.json": JSON.stringify({ packageManager: "bun@1.3.14" }),
    "packages/desktop/package.json": JSON.stringify({
      devDependencies: { electron: "42.3.3", "electron-builder": "26.15.2" },
    }),
    "bun.lock": "fixture immutable lockfile\n",
    "release/models.dev-api.json.gz": gzipSync(
      JSON.stringify({ fixture: { models: { simulation: { name: "Synthetic test provider" } } } }),
    ),
    "packages/physicalsystems/vendor/manifest.json": JSON.stringify(manifest),
    ...Object.fromEntries(
      Object.entries(artifacts).map(([name, bytes]) => [`packages/physicalsystems/vendor/${name}`, bytes]),
    ),
  }
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), bytes)
  }
  commit(root)
  return {
    root,
    manifest,
    fixturePolicy,
    input: { repoRoot: root, repository: "PhysicalSystems/desktop", channel: "preview" as const, history },
    async manifestCommit() {
      await writeFile(path.join(root, "packages/physicalsystems/vendor/manifest.json"), JSON.stringify(manifest))
      commit(root)
    },
    async policyCommit() {
      await writeFile(path.join(root, "release/desktop.json"), JSON.stringify(fixturePolicy))
      commit(root)
    },
  }
}

async function preparedFixture() {
  const data = await fixture()
  const sourceRevision = git(data.root, "rev-parse", "HEAD")
  const producerPolicy = freezePublicProducerPolicy({
    GITHUB_REPOSITORY: "PhysicalSystems/desktop",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: sourceRevision,
    DESKTOP_PUBLIC_BUILD_ENABLED: "true",
    DESKTOP_WINDOWS_SIGNING_POLICY: JSON.stringify({
      provider: "pfx",
      publisher: "Fixture Publisher",
      certificateThumbprint: "A".repeat(40),
    }),
  })
  const output = await mkdtemp(path.join(tmpdir(), "physical-upgrade-prepared-"))
  directories.push(output)
  const result = await preparePublicUpgradeInputs({
    root: data.root,
    sourceRevision,
    history,
    channel: "preview",
    policy: producerPolicy,
    expectedPolicySha256: publicReviewDigest(producerPolicy),
    output,
  })
  const env: NodeJS.ProcessEnv = {
    PUBLIC_RELEASE_INPUTS: path.join(output, "release-inputs.json"),
    PUBLIC_BUILD_INPUTS: path.join(output, "public-build-inputs.json"),
    PUBLIC_BASELINE_RELEASE_INPUTS: path.join(output, "baseline/release-inputs.json"),
    PUBLIC_BASELINE_BUILD_INPUTS: path.join(output, "baseline/public-build-inputs.json"),
    PUBLIC_UPGRADE_PLAN: path.join(output, "upgrade-plan.json"),
    EXPECTED_RELEASE_INPUTS_SHA256: result.inputs_sha256,
    EXPECTED_PUBLIC_BUILD_SHA256: result.public_build_sha256,
    EXPECTED_BASELINE_RELEASE_INPUTS_SHA256: result.baseline_inputs_sha256,
    EXPECTED_BASELINE_PUBLIC_BUILD_SHA256: result.baseline_public_build_sha256,
    EXPECTED_UPGRADE_PLAN_SHA256: result.upgrade_plan_sha256,
  }
  return { ...data, result, output, env }
}

let prepared: Awaited<ReturnType<typeof preparedFixture>>
beforeAll(async () => {
  // Source preparation is shared; each case exercises a separate real load of
  // the frozen pair without repeating its Git history and input construction.
  prepared = await preparedFixture()
})

test("freezes two real clean-source input bundles with distinct versions and the same policy", async () => {
  expect(prepared.result.version).toBe("0.1.0-beta.2")
  expect(prepared.result.baseline_version).toBe("0.1.0-beta.1")
  const loaded = await loadPublicUpgradeInputs({ root: prepared.root, env: prepared.env })
  expect(loaded.plan.publication).toBe(false)
  expect(loaded.plan.baselinePurpose).toBe("unreleased-lab-only")
  expect(loaded.target.source).toEqual(loaded.baseline.source)
  expect(loaded.target.sha256).not.toBe(loaded.baseline.sha256)
  expect(loaded.targetPublic.windowsSigning).toEqual(loaded.baselinePublic.windowsSigning)
  expect(JSON.parse(await readFile(path.join(prepared.output, "history.json"), "utf8"))).toEqual({
    complete: true,
    versions: ["0.1.0-beta.1"],
  })
  expect(JSON.parse(await readFile(path.join(prepared.output, "baseline/history.json"), "utf8"))).toEqual(history)
  expect(await readFile(path.join(prepared.output, "models.dev-api.json"), "utf8")).toBe(
    await readFile(path.join(prepared.output, "baseline/models.dev-api.json"), "utf8"),
  )
  expect(git(prepared.root, "status", "--porcelain")).toBe("")
  expect(history).toEqual({ complete: true, versions: [] })
})

test("loading the frozen pair rejects a changed upgrade-plan digest", async () => {
  await expect(
    loadPublicUpgradeInputs({
      root: prepared.root,
      env: { ...prepared.env, EXPECTED_UPGRADE_PLAN_SHA256: "0".repeat(64) },
    }),
  ).rejects.toThrow()
})

test("loading the frozen pair rejects a changed lab source", async () => {
  const file = prepared.env.PUBLIC_BASELINE_BUILD_INPUTS!
  const original = await readFile(file, "utf8")
  try {
    const baseline = JSON.parse(original)
    baseline.sourceRevision = "b".repeat(40)
    await writeFile(file, JSON.stringify(baseline))
    await expect(loadPublicUpgradeInputs({ root: prepared.root, env: prepared.env })).rejects.toThrow()
  } finally {
    await writeFile(file, original)
  }
})
