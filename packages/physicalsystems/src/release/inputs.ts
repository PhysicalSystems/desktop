// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"

export type ReleaseHistory = { complete: true; versions: string[] }
export type ReleaseChannel = "preview" | "stable"

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/
const revisionPattern = /^[a-f0-9]{40}$/
const digestPattern = /^[a-f0-9]{64}$/
const targetPolicy = [
  { platform: "win32", arch: "x64", formats: ["nsis"] },
  { platform: "linux", arch: "x64", formats: ["deb", "AppImage"] },
]
const qualificationPolicy = {
  scope: "simulation-only",
  hardwareVerified: false,
  opticalFlickerMeasured: false,
  nodeCompatibility: "pending",
  operatorApiCompatibility: "pending",
  desktopDataCompatibility: "pending",
  installationLifecycle: "pending",
  nativeCredentialStorage: "pending",
  windowsSigning: "pending",
  downloadDestination: "pending",
}

/** History must include all allocated desktop versions, including drafts and prereleases. */
export function allocateDesktopVersion(input: {
  channel: ReleaseChannel
  requestedVersion?: string
  history: ReleaseHistory
}) {
  if (input.channel !== "preview" && input.channel !== "stable") throw new Error("Invalid desktop release channel")
  const versions = releaseHistory(input.history)
  const latest = versions.at(-1)
  if (input.channel === "stable" && !input.requestedVersion) {
    throw new Error("Stable desktop releases require an explicit version")
  }
  const version = input.requestedVersion ?? nextPreview(latest)
  const parsed = parseVersion(version)
  if (Boolean(parsed[3]) !== (input.channel === "preview")) throw new Error("Desktop version does not match channel")
  if (compareVersion(version, "0.1.0-beta.1") < 0) throw new Error("Desktop version precedes the initial release")
  if (versions.includes(version)) throw new Error(`Desktop version ${version} is already allocated`)
  if (latest && compareVersion(version, latest) <= 0) throw new Error("Desktop version must advance complete history")
  return version
}

function parseVersion(value: unknown): [number, number, number, number | undefined] {
  if (typeof value !== "string" || value.trim() !== value || !versionPattern.test(value))
    throw new Error("Malformed desktop release version")
  const match = versionPattern.exec(value)!
  const numbers = match.slice(1).map((part) => (part === undefined ? undefined : Number(part)))
  if (numbers.some((part) => part !== undefined && !Number.isSafeInteger(part))) {
    throw new Error("Desktop release version exceeds safe numeric range")
  }
  return [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]]
}

function compareVersion(left: string, right: string) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const index of [0, 1, 2] as const) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  if (a[3] === b[3]) return 0
  if (a[3] === undefined) return 1
  if (b[3] === undefined) return -1
  return a[3] - b[3]
}

function nextPreview(latest: string | undefined) {
  if (!latest) return "0.1.0-beta.1"
  const [major, minor, patch, beta] = parseVersion(latest)
  return beta === undefined ? `${major}.${minor}.${patch + 1}-beta.1` : `${major}.${minor}.${patch}-beta.${beta + 1}`
}

function releaseHistory(history: ReleaseHistory) {
  if (
    !history ||
    history.complete !== true ||
    !Array.isArray(history.versions) ||
    Object.keys(history).some((key) => key !== "complete" && key !== "versions")
  ) {
    throw new Error("Complete desktop release history is required")
  }
  history.versions.forEach(parseVersion)
  if (new Set(history.versions).size !== history.versions.length) throw new Error("Duplicate desktop history version")
  return [...history.versions].sort(compareVersion)
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("Release inputs must be JSON values")
  return encoded
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function releaseInputDigest(record: Record<string, unknown>) {
  const { sha256: _digest, ...content } = record
  return sha256(canonical(content))
}

function git(root: string, args: string[]) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim()
}

function safeRelative(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe release input path")
  return value
}

async function regularFile(root: string, relative: string) {
  const parts = safeRelative(relative).split("/")
  for (let index = 1; index <= parts.length; index++) {
    const stat = await lstat(path.join(root, ...parts.slice(0, index)))
    if (stat.isSymbolicLink()) throw new Error(`Symlink is forbidden in release inputs: ${relative}`)
    if (index === parts.length && !stat.isFile()) throw new Error(`Release input is not a regular file: ${relative}`)
    if (index < parts.length && !stat.isDirectory())
      throw new Error(`Release input parent is not a directory: ${relative}`)
  }
  return readFile(path.join(root, relative))
}

async function trackedFile(root: string, relative: string) {
  const bytes = await regularFile(root, relative)
  const entry = git(root, ["ls-tree", "HEAD", "--", relative])
  if (!entry.startsWith("100644 blob ") && !entry.startsWith("100755 blob ")) {
    throw new Error(`Release input is not a tracked regular file: ${relative}`)
  }
  const committed = execFileSync("git", ["-C", root, "show", `HEAD:${relative}`], { maxBuffer: 32 * 1024 * 1024 })
  if (!bytes.equals(committed)) throw new Error(`Release source differs from its commit: ${relative}`)
  return bytes
}

async function filesBelow(root: string, relative: string): Promise<string[]> {
  const directory = path.join(root, relative)
  const entries = await readdir(directory, { withFileTypes: true })
  const listed = await Promise.all(
    entries.map(async (entry) => {
      const child = `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`Symlink is forbidden in operator artifacts: ${child}`)
      if (entry.isDirectory()) return filesBelow(root, child)
      if (!entry.isFile()) throw new Error(`Operator artifact is not a regular file: ${child}`)
      return [child]
    }),
  )
  return listed.flat().sort()
}

function hashMap(value: unknown, label: string) {
  const entries = Object.entries(jsonObject(value, label))
  if (!entries.length) throw new Error(`Empty ${label}`)
  for (const [name, digest] of entries) {
    safeRelative(name)
    if (typeof digest !== "string" || digest.length !== 64 || !digestPattern.test(digest))
      throw new Error(`Invalid ${label} digest`)
  }
  return Object.fromEntries(entries.sort(([a], [b]) => compareText(a, b))) as Record<string, string>
}

/** Capture only committed, credential-free inputs. The caller writes this record outside the checkout. */
export async function prepareReleaseInputs(input: {
  repoRoot: string
  repository: string
  channel: ReleaseChannel
  version?: string
  history: ReleaseHistory
}) {
  if (
    typeof input.repository !== "string" ||
    input.repository.trim() !== input.repository ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository) ||
    [".", ".."].includes(input.repository.split("/")[1]!)
  )
    throw new Error("Expected a GitHub owner/repository")
  const root = await realpath(input.repoRoot)
  if ((await realpath(git(root, ["rev-parse", "--show-toplevel"]))) !== root)
    throw new Error("Expected repository root")
  if (
    git(root, ["ls-files", "-v", "-z"])
      .split("\0")
      .some((entry) => entry && (entry[0] === "S" || entry[0] === entry[0]!.toLowerCase()))
  ) {
    throw new Error("Release source cannot use assume-unchanged or skip-worktree flags")
  }
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) {
    throw new Error("Desktop release source must be clean and committed")
  }
  const version = allocateDesktopVersion({
    channel: input.channel,
    requestedVersion: input.version,
    history: input.history,
  })
  const policyBytes = await trackedFile(root, "release/desktop.json")
  const policy = jsonObject(JSON.parse(policyBytes.toString()), "desktop release policy")
  if (
    policy.schemaVersion !== 1 ||
    policy.product !== "Physical Systems Desktop" ||
    policy.initialVersion !== "0.1.0-beta.1" ||
    policy.tagPrefix !== "desktop-v" ||
    policy.publication !== false
  ) {
    throw new Error("Unsupported desktop release policy")
  }
  if (
    canonical(policy.targets) !== canonical(targetPolicy) ||
    canonical(policy.qualification) !== canonical(qualificationPolicy)
  ) {
    throw new Error("Desktop candidate targets and qualification must remain explicit and publication-disabled")
  }
  const upstream = jsonObject(policy.upstream, "upstream pin")
  if (
    upstream.repository !== "https://github.com/anomalyco/opencode" ||
    typeof upstream.revision !== "string" ||
    upstream.revision.length !== 40 ||
    !revisionPattern.test(upstream.revision)
  ) {
    throw new Error("Upstream source must use an immutable reviewed revision")
  }
  git(root, ["merge-base", "--is-ancestor", upstream.revision, "HEAD"])
  const source = {
    repository: input.repository,
    revision: git(root, ["rev-parse", "HEAD"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
    upstream: { repository: upstream.repository, revision: upstream.revision },
  }
  if (!revisionPattern.test(source.revision) || !revisionPattern.test(source.tree))
    throw new Error("Unsupported Git object identity")

  const rootPackage = jsonObject(JSON.parse((await trackedFile(root, "package.json")).toString()), "root package")
  const desktop = jsonObject(
    JSON.parse((await trackedFile(root, "packages/desktop/package.json")).toString()),
    "desktop package",
  )
  const devDependencies = jsonObject(desktop.devDependencies, "desktop build dependencies")
  if (typeof rootPackage.packageManager !== "string" || !/^bun@\d+\.\d+\.\d+$/.test(rootPackage.packageManager)) {
    throw new Error("Bun must be pinned in packageManager")
  }
  const toolchain = {
    node: exactPin(policy.buildNode),
    bun: exactPin(rootPackage.packageManager.slice(4)),
    electron: exactPin(devDependencies.electron),
    electronBuilder: exactPin(devDependencies["electron-builder"]),
  }
  const lockfile = { path: "bun.lock", sha256: sha256(await trackedFile(root, "bun.lock")) }

  const operatorPolicy = jsonObject(policy.operator, "operator policy")
  if (operatorPolicy.repository !== "https://github.com/PhysicalSystems/physicalsystems")
    throw new Error("Unexpected canonical operator repository")
  const manifestPath = safeRelative(operatorPolicy.manifestPath)
  const manifestBytes = await trackedFile(root, manifestPath)
  const manifest = jsonObject(JSON.parse(manifestBytes.toString()), "operator manifest")
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== operatorPolicy.repository ||
    manifest.dirty !== false ||
    typeof manifest.revision !== "string" ||
    manifest.revision.length !== 40 ||
    !revisionPattern.test(manifest.revision)
  )
    throw new Error("Canonical operator artifact requires clean, pinned source")
  const sourceFiles = hashMap(manifest.sourceFiles, "operator source files")
  const artifacts = hashMap(manifest.artifacts, "operator artifacts")
  for (const required of [
    "operator-service.mjs",
    "LICENSE",
    "NOTICE",
    "skills/inspect-workcell/SKILL.md",
    "skills/inspect-workcell/physicalsystems.binding.json",
    "skills/transfer-container/SKILL.md",
    "skills/transfer-container/physicalsystems.binding.json",
  ]) {
    if (!artifacts[required]) throw new Error(`Missing required operator artifact: ${required}`)
  }
  const vendorDirectory = path.posix.dirname(manifestPath)
  const expectedFiles = [manifestPath, ...Object.keys(artifacts).map((name) => `${vendorDirectory}/${name}`)].sort()
  if (canonical(await filesBelow(root, vendorDirectory)) !== canonical(expectedFiles))
    throw new Error("Unexpected operator vendor files")
  for (const [name, digest] of Object.entries(artifacts)) {
    if (sha256(await trackedFile(root, `${vendorDirectory}/${name}`)) !== digest)
      throw new Error(`Operator artifact digest mismatch: ${name}`)
  }
  const operator = {
    repository: manifest.repository,
    revision: manifest.revision,
    dirty: false,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    sourceFiles,
    artifacts,
  }

  const modelPolicy = jsonObject(policy.modelCatalog, "model catalog policy")
  const modelPath = safeRelative(modelPolicy.path)
  const models = await trackedFile(root, modelPath)
  const decoded = gunzipSync(models, { maxOutputLength: 32 * 1024 * 1024 })
  if (!Object.keys(jsonObject(JSON.parse(decoded.toString()), "model catalog snapshot")).length)
    throw new Error("Model catalog snapshot is empty")
  const modelCatalog = { path: modelPath, sha256: sha256(models), decodedSha256: sha256(decoded) }
  const record = {
    schemaVersion: 1,
    product: "Physical Systems Desktop",
    version,
    channel: input.channel,
    publication: false,
    source,
    policy: { path: "release/desktop.json", sha256: sha256(policyBytes) },
    toolchain,
    lockfile,
    operator,
    modelCatalog,
    releaseHistory: {
      complete: true,
      count: input.history.versions.length,
      sha256: sha256(canonical(releaseHistory(input.history))),
    },
    targets: structuredClone(targetPolicy),
    qualification: structuredClone(qualificationPolicy),
  }
  // Recheck after reading inputs so concurrent checkout mutations cannot be silently admitted.
  if (
    git(root, ["rev-parse", "HEAD"]) !== source.revision ||
    git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])
  ) {
    throw new Error("Desktop release source changed while preparing inputs")
  }
  return { ...record, sha256: sha256(canonical(record)) }
}

function exactPin(value: unknown) {
  if (typeof value !== "string" || value.trim() !== value || !/^\d+\.\d+\.\d+$/.test(value))
    throw new Error("Desktop build dependencies must be exactly pinned")
  return value
}

export type ReleaseInputs = Awaited<ReturnType<typeof prepareReleaseInputs>>

/** Recreate the entire record, rather than trusting a supplied digest or a mutable source reference. */
export async function verifyReleaseInputs(input: {
  repoRoot: string
  inputs: unknown
  history: ReleaseHistory
  expectedRepository?: string
  expectedSha256?: string
}) {
  const record = jsonObject(input.inputs, "release input record")
  const source = jsonObject(record.source, "release input source")
  if (
    typeof source.repository !== "string" ||
    typeof record.version !== "string" ||
    (record.channel !== "preview" && record.channel !== "stable")
  ) {
    throw new Error("Malformed release input identity")
  }
  if (input.expectedRepository !== undefined && source.repository !== input.expectedRepository) {
    throw new Error("Release input repository does not match the trusted release scope")
  }
  if (
    input.expectedSha256 !== undefined &&
    (!digestPattern.test(input.expectedSha256) ||
      record.sha256 !== input.expectedSha256 ||
      releaseInputDigest(record) !== input.expectedSha256)
  ) {
    throw new Error("Release input digest does not match the trusted preparation receipt")
  }
  const expected = await prepareReleaseInputs({
    repoRoot: input.repoRoot,
    repository: source.repository,
    version: record.version,
    channel: record.channel,
    history: input.history,
  })
  if (canonical(expected) !== canonical(record))
    throw new Error("Release inputs do not match pinned source and release history")
  return expected
}
