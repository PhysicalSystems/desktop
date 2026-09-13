// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gzipSync } from "node:zlib"
import { buildPreviewUpdaterTest, preparePreviewUpdaterTest } from "../../../../script/desktop-preview-update-test"
import { candidateNames } from "./artifacts"
import { desktopIdentity } from "./identity"
import { publicReviewDigest } from "./public-downloads"
import { validatePublicBuildInputs } from "./public-build"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}
function commit(root: string) {
  git(root, "add", ".")
  git(
    root,
    "-c",
    "user.name=Updater fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "test: immutable source",
  )
}

async function fixture(targetVersion = "0.1.0-beta.7", signed = false) {
  const parent = await mkdtemp(join(tmpdir(), "updater-preparation-"))
  roots.push(parent)
  const root = join(parent, "repo")
  const temporary = join(parent, "runner")
  await mkdir(root)
  await mkdir(temporary)
  git(root, "init", "--quiet")
  await writeFile(join(root, "LICENSE"), "fixture license\n")
  commit(root)
  const policy = JSON.parse(await readFile(new URL("../../../../release/desktop.json", import.meta.url), "utf8"))
  policy.upstream.revision = git(root, "rev-parse", "HEAD")
  const artifacts = {
    "operator-service.mjs": "export const fixture = true\n",
    LICENSE: "fixture license",
    NOTICE: "fixture notice",
    "skills/inspect-workcell/SKILL.md": "# Inspect",
    "skills/inspect-workcell/physicalsystems.binding.json": "{}",
    "skills/transfer-container/SKILL.md": "# Transfer",
    "skills/transfer-container/physicalsystems.binding.json": "{}",
  }
  const models = json({ fixture: { models: { synthetic: { name: "Synthetic fixture" } } } })
  const files: Record<string, string | Uint8Array> = {
    "release/desktop.json": json(policy),
    "package.json": json({ packageManager: "bun@1.3.14" }),
    "packages/desktop/package.json": json({ devDependencies: { electron: "42.3.3", "electron-builder": "26.15.2" } }),
    "bun.lock": "fixture lock\n",
    "release/models.dev-api.json.gz": gzipSync(models),
    "packages/physicalsystems/vendor/manifest.json": json({
      schemaVersion: 1,
      repository: "https://github.com/PhysicalSystems/physicalsystems",
      revision: "a".repeat(40),
      dirty: false,
      sourceFiles: { "packages/operator-service/src/index.js": hash("fixture") },
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, hash(bytes)])),
    }),
    ...Object.fromEntries(
      Object.entries(artifacts).map(([name, bytes]) => ["packages/physicalsystems/vendor/" + name, bytes]),
    ),
  }
  for (const [file, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), bytes)
  }
  commit(root)
  const env: NodeJS.ProcessEnv = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "PhysicalSystems/desktop",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/desktop-updater-test",
    GITHUB_SHA: git(root, "rev-parse", "HEAD"),
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: process.platform === "win32" ? "Windows" : "Linux",
    RUNNER_ARCH: "X64",
    RUNNER_TEMP: temporary,
    PHYSICALSYSTEMS_UPDATER_TEST: "1",
    PHYSICALSYSTEMS_ALLOW_DEVICES: "0",
    UPDATER_TEST_HISTORY: json({ complete: true, versions: ["0.1.0-beta.7", "0.1.0-beta.1", "0.1.0-beta.4"] }),
    GITHUB_OUTPUT: join(parent, "step-output"),
  }
  const tag = `desktop-v${targetVersion}`
  const assets = ["windows-x64.exe", "linux-x64.deb", "linux-x64.AppImage"].map((suffix, index) => ({
    name: `physical-systems-desktop-${targetVersion}-${suffix}`,
    bytes: 100 + index,
    sha256: String(index + 1).repeat(64),
  }))
  const selection = {
    schemaVersion: 2,
    repository: "PhysicalSystems/physicalsystems",
    release: {
      tag,
      version: targetVersion,
      channel: "preview",
      releaseId: 100,
      publishedAt: "2026-09-13T17:18:01Z",
      sourceRevision: "a".repeat(40),
      inputsSha256: "b".repeat(64),
      windowsSigning: signed
        ? { status: "verified" }
        : {
            status: "unsigned-preview",
            warning: "Unsigned Windows preview: Windows may warn or block installation.",
          },
      assets,
    },
  }
  const metadata = {
    id: 100,
    tag_name: tag,
    draft: false,
    prerelease: true,
    html_url: `https://github.com/PhysicalSystems/physicalsystems/releases/tag/${tag}`,
    published_at: selection.release.publishedAt,
    assets: assets.map((asset, index) => ({
      id: 101 + index,
      name: asset.name,
      state: "uploaded",
      size: asset.bytes,
      digest: `sha256:${asset.sha256}`,
      browser_download_url: `https://github.com/PhysicalSystems/physicalsystems/releases/download/${tag}/${asset.name}`,
    })),
  }
  const calls: string[] = []
  const fetch = async (url: string, options: RequestInit) => {
    calls.push(url)
    expect(options.method).toBe("GET")
    expect(options.redirect).toBe("error")
    expect(options.credentials).toBe("omit")
    expect(new Headers(options.headers).has("Authorization")).toBe(false)
    if (url === "https://physicalsystems.ai/desktop-selection.json") return Response.json(selection)
    expect(url).toBe(`https://api.github.com/repos/PhysicalSystems/physicalsystems/releases/tags/${tag}`)
    return Response.json(metadata)
  }
  return { parent, root, temporary, env, fetch, calls, metadata, options: { env, repoRoot: root, fetch } }
}

test("preparation binds real clean source and full history to metadata-only official discovery", async () => {
  const f = await fixture()
  const result = await preparePreviewUpdaterTest(f.options)
  expect(result.plan.version).toBe("0.1.0-beta.1")
  expect(result.plan.sourceRevision).toBe(f.env.GITHUB_SHA!)
  expect(result.plan.target.version).toBe("0.1.0-beta.7")
  expect(result.plan.target.assets).toHaveLength(3)
  expect(f.calls).toHaveLength(2)
  expect(result.plan.publication).toBe(false)
  expect(result.plan.qualification).toBe(false)
  expect(result.planSha256).toBe(publicReviewDigest(result.plan))
  expect(await readFile(join(result.root, "inputs/history.json"), "utf8")).toBe(f.env.UPDATER_TEST_HISTORY!)
  const build = JSON.parse(await readFile(join(result.root, "inputs/public-build-inputs.json"), "utf8"))
  expect(build.updaterTest).toBe("unreleased-updater-test-only")
  expect(() => validatePublicBuildInputs(build, result.plan.publicBuildInputsSha256)).toThrow("cannot enter public")
  const acknowledgement = result.plan.startupAcknowledgement
  expect(acknowledgement.version).toBe("0.1.0-beta.8")
  const ackBuild = JSON.parse(await readFile(join(result.root, "ack-inputs/public-build-inputs.json"), "utf8"))
  const ackRelease = JSON.parse(await readFile(join(result.root, "ack-inputs/release-inputs.json"), "utf8"))
  const baselineRelease = JSON.parse(await readFile(join(result.root, "inputs/release-inputs.json"), "utf8"))
  expect(ackBuild).not.toHaveProperty("updaterTest")
  expect(ackRelease).not.toHaveProperty("upgradeLab")
  expect(validatePublicBuildInputs(ackBuild, acknowledgement.publicBuildInputsSha256)).toEqual(ackBuild)
  expect(ackBuild.releaseInputsSha256).toBe(acknowledgement.releaseInputsSha256)
  expect(ackRelease.sha256).toBe(acknowledgement.releaseInputsSha256)
  expect(ackRelease.source).toEqual(baselineRelease.source)
  expect(ackRelease.releaseHistory).toEqual(baselineRelease.releaseHistory)
  expect(ackRelease.publication).toBe(false)
  expect(await readFile(join(result.root, "ack-inputs/history.json"), "utf8")).toBe(f.env.UPDATER_TEST_HISTORY!)
  expect(JSON.parse(await readFile(join(result.root, "preview-update-runner.json"), "utf8"))).toEqual({
    kind: "disposable-preview-update",
    runId: "12345",
  })
  expect(await readFile(f.env.GITHUB_OUTPUT!, "utf8")).toContain(`plan_sha256=${result.planSha256}\n`)
  if (process.platform !== "win32") {
    expect((await lstat(result.root)).mode & 0o777).toBe(0o700)
    for (const file of ["owner.json", "preview-update-runner.json", "plan.json", "inputs/release-inputs.json"])
      expect((await lstat(join(result.root, file))).mode & 0o777).toBe(0o600)
  }
  await expect(preparePreviewUpdaterTest(f.options)).rejects.toThrow()
  expect(git(f.root, "status", "--porcelain")).toBe("")
})

test("off-host, unsolicited, foreign-source and incomplete-history preparations fail before output", async () => {
  const f = await fixture()
  for (const change of [
    { PHYSICALSYSTEMS_UPDATER_TEST: "0" },
    { PHYSICALSYSTEMS_ALLOW_DEVICES: "1" },
    { GITHUB_REPOSITORY: "Other/desktop" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_SHA: "c".repeat(40) },
    { UPDATER_TEST_HISTORY: json({ complete: false, versions: [] }) },
    { UPDATER_TEST_HISTORY: json({ complete: true, versions: ["0.1.0-beta.1", "0.1.0-beta.1"] }) },
  ])
    await expect(preparePreviewUpdaterTest({ ...f.options, env: { ...f.env, ...change } })).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
  expect(await readdir(f.temporary)).toEqual([])
  await writeFile(join(f.root, "LICENSE"), "uncommitted change")
  await expect(preparePreviewUpdaterTest(f.options)).rejects.toThrow("clean")
  expect(await readdir(f.temporary)).toEqual([])
})

test("an unavailable, unchanged or inconsistent official target cannot create a test plan", async () => {
  const f = await fixture("0.1.0-beta.1")
  await expect(preparePreviewUpdaterTest(f.options)).rejects.toThrow()
  expect(await readdir(f.temporary)).toEqual([])
  f.metadata.assets[0]!.size++
  await expect(preparePreviewUpdaterTest(f.options)).rejects.toThrow()
  expect(await readdir(f.temporary)).toEqual([])
  await expect(
    preparePreviewUpdaterTest({ ...f.options, fetch: async () => new Response(null, { status: 503 }) }),
  ).rejects.toThrow()
  expect(await readdir(f.temporary)).toEqual([])
})

test("a signed official preview target is rejected before creating a test plan", async () => {
  const f = await fixture("0.1.0-beta.7", true)
  await expect(preparePreviewUpdaterTest(f.options)).rejects.toThrow("PREVIEW_UPDATER_TEST_INPUTS_INVALID")
  expect(f.calls).toHaveLength(2)
  expect(await readdir(f.temporary)).toEqual([])
})

test("build rejects a replaced plan, run owner or removed marker before invoking packaging", async () => {
  const f = await fixture()
  const prepared = await preparePreviewUpdaterTest(f.options)
  f.env.UPDATER_TEST_PLAN_SHA256 = prepared.planSha256
  let called = false
  const build = async () => {
    called = true
    throw new Error("Unexpected build")
  }
  for (const change of [{ UPDATER_TEST_PLAN_SHA256: "d".repeat(64) }, { GITHUB_RUN_ID: "12346" }])
    await expect(buildPreviewUpdaterTest({ ...f.options, build, env: { ...f.env, ...change } })).rejects.toThrow()
  const publicFile = join(prepared.root, "inputs/public-build-inputs.json")
  const publicInputs = JSON.parse(await readFile(publicFile, "utf8"))
  delete publicInputs.updaterTest
  await writeFile(publicFile, json(publicInputs))
  await expect(buildPreviewUpdaterTest({ ...f.options, build })).rejects.toThrow()
  expect(called).toBe(false)
  expect(await readdir(prepared.root)).not.toContain("build")
})

test("acknowledgement uses ordinary next-version allocation and refuses history behind the real target", async () => {
  const f = await fixture()
  f.env.UPDATER_TEST_HISTORY = json({ complete: true, versions: ["0.1.0-beta.1", "0.1.0-beta.7", "0.1.0-beta.9"] })
  const prepared = await preparePreviewUpdaterTest(f.options)
  expect(prepared.plan.startupAcknowledgement.version).toBe("0.1.0-beta.10")
  expect(await readFile(join(prepared.root, "ack-inputs/history.json"), "utf8")).toBe(f.env.UPDATER_TEST_HISTORY!)
  const stale = await fixture()
  stale.env.UPDATER_TEST_HISTORY = json({ complete: true, versions: ["0.1.0-beta.1", "0.1.0-beta.4"] })
  await expect(preparePreviewUpdaterTest(stale.options)).rejects.toThrow("PREVIEW_UPDATER_TEST_INPUTS_INVALID")
  expect(await readdir(stale.temporary)).toEqual([])
})

test.each(["digest", "purpose", "source"])("changed acknowledgement %s cannot enter either build", async (change) => {
  const f = await fixture()
  const prepared = await preparePreviewUpdaterTest(f.options)
  const publicFile = join(prepared.root, "ack-inputs/public-build-inputs.json")
  const publicInputs = JSON.parse(await readFile(publicFile, "utf8"))
  if (change === "purpose") publicInputs.updaterTest = "unreleased-updater-test-only"
  else publicInputs.sourceRevision = "d".repeat(40)
  await writeFile(publicFile, json(publicInputs))
  if (change !== "digest") {
    prepared.plan.startupAcknowledgement.publicBuildInputsSha256 = publicReviewDigest(publicInputs)
    await writeFile(join(prepared.root, "plan.json"), json(prepared.plan))
  }
  f.env.UPDATER_TEST_PLAN_SHA256 = publicReviewDigest(prepared.plan)
  let called = false
  await expect(
    buildPreviewUpdaterTest({
      ...f.options,
      build: async () => {
        called = true
        throw new Error("Unexpected build")
      },
    }),
  ).rejects.toThrow(
    change === "purpose"
      ? "cannot enter public"
      : change === "digest"
        ? "trusted digest"
        : "PREVIEW_UPDATER_TEST_INPUTS_INVALID",
  )
  expect(called).toBe(false)
  expect(await readdir(prepared.root)).not.toContain("build")
  expect(await readdir(prepared.root)).not.toContain("ack-build")
})

test("the build wrapper separately binds both ordinary pipelines and exact native installers", async () => {
  const f = await fixture()
  const prepared = await preparePreviewUpdaterTest(f.options)
  f.env.UPDATER_TEST_PLAN_SHA256 = prepared.planSha256
  const versions: string[] = []
  const result = await buildPreviewUpdaterTest({
    ...f.options,
    build: async (args, options) => {
      const acknowledgement = versions.length === 1
      const expected = acknowledgement ? prepared.plan.startupAcknowledgement : prepared.plan
      const inputDirectory = acknowledgement ? "ack-inputs" : "inputs"
      const outputDirectory = acknowledgement ? "ack-build" : "build"
      versions.push(expected.version)
      expect(args).toEqual([
        "--inputs",
        join(prepared.root, inputDirectory, "release-inputs.json"),
        "--public-inputs",
        join(prepared.root, inputDirectory, "public-build-inputs.json"),
        "--expected-inputs-sha256",
        expected.releaseInputsSha256,
        "--expected-public-build-sha256",
        expected.publicBuildInputsSha256,
        "--platform",
        prepared.plan.platform,
        "--output",
        join(prepared.root, outputDirectory),
      ])
      expect(options?.root).toBe(await realpath(f.root))
      await mkdir(join(prepared.root, outputDirectory))
      for (const artifact of candidateNames(expected.version, prepared.plan.platform))
        await writeFile(
          join(prepared.root, outputDirectory, artifact.name),
          `SIMULATED INSTALLER ${expected.version}; NEVER EXECUTED`,
        )
      return {
        schemaVersion: 1,
        kind: "unqualified-public-desktop-build",
        publication: false,
        publicBuildInputsSha256: expected.publicBuildInputsSha256,
        releaseInputsSha256: expected.releaseInputsSha256,
        sourceRevision: prepared.plan.sourceRevision,
        version: expected.version,
        channel: "preview",
        platform: prepared.plan.platform,
        identity: desktopIdentity("public"),
        compiledIdentity: {},
        inventorySha256: "d".repeat(64),
        signing: { status: "NOT_VERIFIED", policy: { provider: "unsigned-preview" } },
        qualification: "NOT_TESTED",
      }
    },
  })
  expect(versions).toEqual(["0.1.0-beta.1", "0.1.0-beta.8"])
  expect(result.installer.bytes).toBe(Buffer.byteLength("SIMULATED INSTALLER 0.1.0-beta.1; NEVER EXECUTED"))
  expect(result.installer.sha256).toBe(hash("SIMULATED INSTALLER 0.1.0-beta.1; NEVER EXECUTED"))
  expect(result.installer.path).toBe(join(prepared.root, "build", result.installer.name))
  expect(result.installer.name.endsWith(process.platform === "win32" ? ".exe" : ".deb")).toBe(true)
  expect(result.startupAcknowledgement).toEqual({
    ...prepared.plan.startupAcknowledgement,
    installer: {
      name: result.startupAcknowledgement.installer.name,
      bytes: Buffer.byteLength("SIMULATED INSTALLER 0.1.0-beta.8; NEVER EXECUTED"),
      sha256: hash("SIMULATED INSTALLER 0.1.0-beta.8; NEVER EXECUTED"),
      path: join(prepared.root, "ack-build", result.startupAcknowledgement.installer.name),
    },
  })
  expect(result.publication).toBe(false)
  expect(result.qualification).toBe(false)
  expect(JSON.parse(await readFile(join(prepared.root, "build-record.json"), "utf8"))).toEqual(result)
})

test("native updater CI is explicit, source-gated, disposable and cannot upload packages or publish", async () => {
  const workflow = Bun.YAML.parse(
    await readFile(new URL("../../../../.github/workflows/desktop-ci.yml", import.meta.url), "utf8"),
  ) as {
    on: { workflow_dispatch: { inputs: Record<string, { default?: unknown; type: string }> } }
    jobs: Record<
      string,
      {
        if?: string
        needs?: string[]
        permissions?: Record<string, string>
        strategy?: { matrix: { os: string[] } }
        env?: Record<string, string>
        steps: {
          name?: string
          uses?: string
          env?: Record<string, string>
          with?: Record<string, unknown>
          run?: string
        }[]
      }
    >
  }
  expect(workflow.on.workflow_dispatch.inputs.preview_updater_test).toMatchObject({ type: "boolean", default: false })
  expect(workflow.on.workflow_dispatch.inputs.updater_test_history.type).toBe("string")
  const job = workflow.jobs["preview-updater-test"]!
  expect(job.if).toContain("github.event_name == 'workflow_dispatch'")
  expect(job.if).toContain("github.repository == 'PhysicalSystems/desktop'")
  expect(job.if).toContain("inputs.preview_updater_test")
  expect(job.needs).toEqual(["source"])
  expect(job.permissions).toEqual({ contents: "read" })
  expect(job.strategy?.matrix.os).toEqual(["windows-2025", "ubuntu-24.04"])
  expect(job.env?.PHYSICALSYSTEMS_ALLOW_DEVICES).toBe("0")
  expect(job.env?.PHYSICALSYSTEMS_UPDATER_TEST).toBe("1")
  expect(JSON.stringify(job)).not.toContain("secrets.")
  const uploads = job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
  expect(uploads).toHaveLength(1)
  expect(String(uploads[0]!.with?.path).trim().split("\n")).toEqual([
    "${{ steps.prepare.outputs.root }}/result.json",
    "${{ steps.prepare.outputs.root }}/native-dialog-later.png",
    "${{ steps.prepare.outputs.root }}/native-dialog-install.png",
  ])
  expect(job.steps.find((step) => step.run?.includes("dbus-run-session"))?.run).toContain("xvfb-run -a bun")
  expect(job.steps.filter((step) => step.run?.includes("preview-update-native.mjs"))).toHaveLength(2)
})
