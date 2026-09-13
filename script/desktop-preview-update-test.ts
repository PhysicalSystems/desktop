// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { gunzipSync } from "node:zlib"
import { checkDesktopUpdate } from "../packages/desktop/src/main/desktop-update-discovery"
import { artifactDigest, candidateNames } from "../packages/physicalsystems/src/release/artifacts"
import { desktopIdentity } from "../packages/physicalsystems/src/release/identity"
import {
  prepareUpdaterLabInputs,
  releaseInputDigest,
  UPDATER_LAB_VERSION,
} from "../packages/physicalsystems/src/release/inputs"
import type { ReleaseHistory } from "../packages/physicalsystems/src/release/inputs"
import { validatePublicBuildInputs } from "../packages/physicalsystems/src/release/public-build"
import type { PublicBuildInputs } from "../packages/physicalsystems/src/release/public-build"
import { buildPublicDesktop } from "../packages/physicalsystems/src/release/public-build-command"
import { publicReviewDigest } from "../packages/physicalsystems/src/release/public-downloads"

const repository = "PhysicalSystems/desktop"
const sourceRoot = resolve(import.meta.dir, "..")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const failure = () => new Error("PREVIEW_UPDATER_TEST_INPUTS_INVALID")

type Options = {
  env?: NodeJS.ProcessEnv
  repoRoot?: string
  // Injection is only available to offline orchestration tests, never CLI flags.
  fetch?: Parameters<typeof checkDesktopUpdate>[0]["fetch"]
  build?: typeof buildPublicDesktop
}

async function context(env: NodeJS.ProcessEnv, repoRoot: string) {
  if (
    env.PHYSICALSYSTEMS_UPDATER_TEST !== "1" ||
    env.PHYSICALSYSTEMS_ALLOW_DEVICES !== "0" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !env.GITHUB_REF?.startsWith("refs/heads/") ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT)) ||
    !["win32", "linux"].includes(process.platform) ||
    process.arch !== "x64" ||
    env.RUNNER_ARCH !== "X64" ||
    env.RUNNER_OS !== (process.platform === "win32" ? "Windows" : "Linux") ||
    !isAbsolute(env.RUNNER_TEMP ?? "")
  )
    throw failure()
  const temporary = await realpath(env.RUNNER_TEMP!)
  const source = await realpath(repoRoot)
  const root = join(temporary, "preview-updater-test")
  if (temporary === sep || root === source || root.startsWith(source + sep)) throw failure()
  const platform = process.platform === "win32" ? ("windows-x64" as const) : ("linux-x64" as const)
  const owner = {
    schemaVersion: 1,
    kind: "preview-updater-test-owner",
    repository,
    sourceRevision: env.GITHUB_SHA!,
    runId: env.GITHUB_RUN_ID!,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    platform,
  }
  return { root, source, platform, owner }
}

async function privateDirectory(directory: string) {
  const stat = await lstat(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0))
  )
    throw failure()
}

async function read(file: string): Promise<unknown> {
  const stat = await lstat(file)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > 1024 ** 2 ||
    (process.platform !== "win32" && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0))
  )
    throw failure()
  return JSON.parse(await readFile(file, "utf8")) as unknown
}

async function write(file: string, value: unknown) {
  await writeFile(file, json(value), { flag: "wx", mode: 0o600 })
}

export async function preparePreviewUpdaterTest(options: Options = {}) {
  const env = options.env ?? process.env
  const { root, source, platform, owner } = await context(env, options.repoRoot ?? sourceRoot)
  if (!env.UPDATER_TEST_HISTORY || Buffer.byteLength(env.UPDATER_TEST_HISTORY) > 1024 * 1024) throw failure()
  const history = JSON.parse(env.UPDATER_TEST_HISTORY) as ReleaseHistory
  const release = await prepareUpdaterLabInputs({ repoRoot: source, repository, history })
  if (
    release.source.revision !== owner.sourceRevision ||
    release.source.repository !== repository ||
    release.version !== UPDATER_LAB_VERSION ||
    release.channel !== "preview" ||
    release.publication !== false ||
    release.upgradeLab !== "unreleased-updater-test-only" ||
    release.sha256 !== releaseInputDigest(release)
  )
    throw failure()
  const publicInputs: PublicBuildInputs = {
    schemaVersion: 1,
    kind: "public-desktop-build",
    sourceRevision: release.source.revision,
    releaseInputsSha256: release.sha256,
    version: release.version,
    channel: "preview",
    identity: desktopIdentity("public"),
    windowsSigning: { provider: "unsigned-preview" },
    publication: false,
    updaterTest: "unreleased-updater-test-only",
  }
  const publicBuildInputsSha256 = publicReviewDigest(publicInputs)
  validatePublicBuildInputs(publicInputs, publicBuildInputsSha256, { allowUpdaterTest: true })
  const target = await checkDesktopUpdate({
    currentVersion: release.version,
    packaged: true,
    platform: process.platform,
    arch: process.arch,
    identity: publicInputs.identity,
    fetch: options.fetch,
  })
  if (target.status !== "available" || target.channel !== "preview" || !target.unsignedWindowsPreview) throw failure()
  const compressed = await readFile(join(source, "release/models.dev-api.json.gz"))
  const models = gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 })
  if (hash(compressed) !== release.modelCatalog.sha256 || hash(models) !== release.modelCatalog.decodedSha256)
    throw failure()
  const plan = {
    schemaVersion: 1,
    kind: "unpublished-preview-updater-test",
    publication: false,
    qualification: false,
    sourceRevision: release.source.revision,
    version: release.version,
    platform,
    releaseInputsSha256: release.sha256,
    publicBuildInputsSha256,
    target,
  }
  // An existing directory or symlink must never be adopted as a fresh test root.
  await mkdir(root, { mode: 0o700 })
  await write(join(root, "owner.json"), owner)
  await write(join(root, "preview-update-runner.json"), { kind: "disposable-preview-update", runId: owner.runId })
  const inputs = join(root, "inputs")
  await mkdir(inputs, { mode: 0o700 })
  await write(join(inputs, "release-inputs.json"), release)
  await write(join(inputs, "public-build-inputs.json"), publicInputs)
  await write(join(inputs, "history.json"), history)
  await writeFile(join(inputs, "models.dev-api.json"), models, { flag: "wx", mode: 0o600 })
  await write(join(root, "plan.json"), plan)
  const planSha256 = publicReviewDigest(plan)
  if (env.GITHUB_OUTPUT) {
    if (/[\r\n]/.test(root)) throw failure()
    await appendFile(env.GITHUB_OUTPUT, `root=${root}\nplan_sha256=${planSha256}\n`)
  }
  return { root, plan, planSha256 }
}

export async function buildPreviewUpdaterTest(options: Options = {}) {
  const env = options.env ?? process.env
  const { root, source, platform, owner } = await context(env, options.repoRoot ?? sourceRoot)
  await privateDirectory(root)
  await privateDirectory(join(root, "inputs"))
  if (
    publicReviewDigest(await read(join(root, "owner.json"))) !== publicReviewDigest(owner) ||
    publicReviewDigest(await read(join(root, "preview-update-runner.json"))) !==
      publicReviewDigest({ kind: "disposable-preview-update", runId: owner.runId })
  )
    throw failure()
  const plan = (await read(join(root, "plan.json"))) as Awaited<ReturnType<typeof preparePreviewUpdaterTest>>["plan"]
  if (
    !/^[a-f0-9]{64}$/.test(env.UPDATER_TEST_PLAN_SHA256 ?? "") ||
    publicReviewDigest(plan) !== env.UPDATER_TEST_PLAN_SHA256 ||
    plan.schemaVersion !== 1 ||
    plan.kind !== "unpublished-preview-updater-test" ||
    plan.publication !== false ||
    plan.qualification !== false ||
    plan.sourceRevision !== owner.sourceRevision ||
    plan.version !== UPDATER_LAB_VERSION ||
    plan.platform !== platform
  )
    throw failure()
  const inputs = join(root, "inputs")
  const releaseFile = join(inputs, "release-inputs.json")
  const publicFile = join(inputs, "public-build-inputs.json")
  const publicInputs = validatePublicBuildInputs(await read(publicFile), plan.publicBuildInputsSha256, {
    allowUpdaterTest: true,
  })
  if (
    publicInputs.updaterTest !== "unreleased-updater-test-only" ||
    publicInputs.releaseInputsSha256 !== plan.releaseInputsSha256 ||
    publicInputs.sourceRevision !== owner.sourceRevision
  )
    throw failure()
  // The normal build pipeline independently verifies source, complete history,
  // input hashes and matching test markers before it creates output or compiles.
  const build = await (options.build ?? buildPublicDesktop)(
    [
      "--inputs",
      releaseFile,
      "--public-inputs",
      publicFile,
      "--expected-inputs-sha256",
      plan.releaseInputsSha256,
      "--expected-public-build-sha256",
      plan.publicBuildInputsSha256,
      "--platform",
      platform,
      "--output",
      join(root, "build"),
    ],
    { root: source, env },
  )
  if (
    build.sourceRevision !== owner.sourceRevision ||
    build.version !== plan.version ||
    build.platform !== platform ||
    build.publication !== false ||
    build.qualification !== "NOT_TESTED" ||
    build.releaseInputsSha256 !== plan.releaseInputsSha256 ||
    build.publicBuildInputsSha256 !== plan.publicBuildInputsSha256
  )
    throw failure()
  const installer = candidateNames(plan.version, platform).find(
    (entry) => entry.format === (platform === "windows-x64" ? "nsis" : "deb"),
  )!
  const file = join(root, "build", installer.name)
  const observed = await artifactDigest(file)
  const record = {
    schemaVersion: 1,
    kind: "unpublished-preview-updater-test-build",
    publication: false,
    qualification: false,
    sourceRevision: owner.sourceRevision,
    version: plan.version,
    platform,
    releaseInputsSha256: plan.releaseInputsSha256,
    publicBuildInputsSha256: plan.publicBuildInputsSha256,
    installer: { name: installer.name, bytes: observed.bytes, sha256: observed.sha256, path: file },
  }
  await write(join(root, "build-record.json"), record)
  return record
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || !["prepare", "build"].includes(process.argv[2] ?? "")) throw failure()
    if (process.argv[2] === "prepare") await preparePreviewUpdaterTest()
    else await buildPreviewUpdaterTest()
    console.log("Unpublished updater test preparation completed; no publication or qualification authority granted")
  } catch {
    console.error("PREVIEW_UPDATER_TEST_PREPARATION_FAILED")
    process.exitCode = 1
  }
}
