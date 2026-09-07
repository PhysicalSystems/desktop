// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { allocateDesktopVersion, prepareReleaseInputs, releaseInputDigest, verifyReleaseInputs } from "./inputs"

const directories: string[] = []
const history = { complete: true as const, versions: [] as string[] }
const policy = JSON.parse(await readFile(new URL("../../../../release/desktop.json", import.meta.url), "utf8"))

afterEach(async () => {
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

describe("desktop version allocation", () => {
  test("allocates a separate preview sequence across complete unsorted history", () => {
    expect(allocateDesktopVersion({ channel: "preview", history })).toBe("0.1.0-beta.1")
    expect(
      allocateDesktopVersion({
        channel: "preview",
        history: { complete: true, versions: ["0.1.0-beta.9", "0.1.0-beta.2"] },
      }),
    ).toBe("0.1.0-beta.10")
    expect(
      allocateDesktopVersion({ channel: "preview", history: { complete: true, versions: ["0.1.0", "0.1.0-beta.9"] } }),
    ).toBe("0.1.1-beta.1")
  })

  test("requires explicit stable promotion and refuses reuse or backward candidates", () => {
    const used = { complete: true as const, versions: ["0.1.0-beta.2"] }
    expect(() => allocateDesktopVersion({ channel: "stable", history: used })).toThrow("explicit version")
    expect(allocateDesktopVersion({ channel: "stable", requestedVersion: "0.1.0", history: used })).toBe("0.1.0")
    expect(() =>
      allocateDesktopVersion({ channel: "preview", requestedVersion: "0.1.0-beta.2", history: used }),
    ).toThrow("already allocated")
    expect(() =>
      allocateDesktopVersion({ channel: "preview", requestedVersion: "0.1.0-beta.1", history: used }),
    ).toThrow("advance")
    expect(() => allocateDesktopVersion({ channel: "preview", requestedVersion: "0.1.0", history })).toThrow(
      "match channel",
    )
    expect(() => allocateDesktopVersion({ channel: "stable", requestedVersion: "0.1.0-beta.1", history })).toThrow(
      "match channel",
    )
  })

  test("fails closed for incomplete, duplicate, malformed or unsafe version history", () => {
    expect(() =>
      allocateDesktopVersion({ channel: "preview", history: { complete: false, versions: [] } as never }),
    ).toThrow("Complete")
    expect(() =>
      allocateDesktopVersion({
        channel: "preview",
        history: { complete: true, versions: [], token: "must not be copied" } as never,
      }),
    ).toThrow("Complete")
    expect(() =>
      allocateDesktopVersion({ channel: "preview", history: { complete: true, versions: ["0.1.0", "0.1.0"] } }),
    ).toThrow("Duplicate")
    for (const invalid of [
      "latest",
      "v0.1.0",
      "0.1.0-beta.01",
      "0.01.0",
      "0.1.0+local",
      "0.1.0-rc.1",
      "0.1.0-beta.1\n",
      "9007199254740992.1.0",
    ]) {
      expect(() =>
        allocateDesktopVersion({ channel: "preview", history: { complete: true, versions: [invalid] } }),
      ).toThrow()
    }
    expect(() => allocateDesktopVersion({ channel: "preview", requestedVersion: "0.0.9-beta.1", history })).toThrow(
      "initial release",
    )
  })
})

describe("immutable desktop release inputs from real Git checkouts", () => {
  test("rejects invalid or ambiguous repository identities", async () => {
    const data = await fixture()
    for (const repository of [
      "../desktop",
      "owner/..",
      "owner/.",
      "owner/repo/extra",
      "https://github.com/owner/repo",
      "owner/repo\n",
    ]) {
      await expect(prepareReleaseInputs({ ...data.input, repository })).rejects.toThrow("owner/repository")
    }
  })

  test("records source tree, actual artifact bytes, pins and compressed catalog; verifies unchanged", async () => {
    const data = await fixture()
    const inputs = await prepareReleaseInputs(data.input)
    expect(inputs.source.revision).toBe(git(data.root, "rev-parse", "HEAD"))
    expect(inputs.source.tree).toBe(git(data.root, "rev-parse", "HEAD^{tree}"))
    expect(inputs.toolchain).toEqual({ node: "22.19.0", bun: "1.3.14", electron: "42.3.3", electronBuilder: "26.15.2" })
    expect(inputs.operator.artifacts).toEqual(data.manifest.artifacts)
    expect(inputs.modelCatalog.sha256).not.toBe(inputs.modelCatalog.decodedSha256)
    expect(inputs.publication).toBe(false)
    expect(inputs.qualification.hardwareVerified).toBe(false)
    expect(inputs.qualification.opticalFlickerMeasured).toBe(false)
    expect(inputs.sha256).toBe(releaseInputDigest(inputs))
    expect(JSON.stringify(inputs)).not.toContain(data.root)
    expect(
      await verifyReleaseInputs({ repoRoot: data.root, inputs: JSON.parse(JSON.stringify(inputs)), history }),
    ).toEqual(inputs)
  })

  test("rejects unstaged, untracked and index-hidden changes instead of pinning a dirty tree", async () => {
    const data = await fixture()
    await writeFile(path.join(data.root, "LICENSE"), "edited\n")
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("clean")
    git(data.root, "checkout", "--", "LICENSE")
    await writeFile(path.join(data.root, "untracked.txt"), "local evidence")
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("clean")
    await rm(path.join(data.root, "untracked.txt"))
    git(data.root, "update-index", "--assume-unchanged", "LICENSE")
    await writeFile(path.join(data.root, "LICENSE"), "hidden edit\n")
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("assume-unchanged")
  })

  test("rejects record tampering even after an attacker recomputes the supplied digest", async () => {
    const data = await fixture()
    const inputs = await prepareReleaseInputs(data.input)
    inputs.qualification.hardwareVerified = true
    inputs.sha256 = releaseInputDigest(inputs)
    await expect(verifyReleaseInputs({ repoRoot: data.root, inputs, history })).rejects.toThrow("do not match")
  })

  test("binds externally declared repository and version to the trusted preparation digest", async () => {
    const data = await fixture()
    const inputs = await prepareReleaseInputs(data.input)
    const expectedSha256 = inputs.sha256
    expect(
      await verifyReleaseInputs({
        repoRoot: data.root,
        inputs,
        history,
        expectedRepository: data.input.repository,
        expectedSha256,
      }),
    ).toEqual(inputs)
    inputs.source.repository = "SomeoneElse/desktop"
    inputs.sha256 = releaseInputDigest(inputs)
    await expect(
      verifyReleaseInputs({ repoRoot: data.root, inputs, history, expectedRepository: data.input.repository }),
    ).rejects.toThrow("trusted release scope")
    inputs.source.repository = data.input.repository
    inputs.version = "0.1.0-beta.2"
    inputs.sha256 = releaseInputDigest(inputs)
    await expect(verifyReleaseInputs({ repoRoot: data.root, inputs, history, expectedSha256 })).rejects.toThrow(
      "trusted preparation receipt",
    )
  })

  test("does not let an old input record follow a later source commit or changed history", async () => {
    const data = await fixture()
    const inputs = await prepareReleaseInputs(data.input)
    await expect(
      verifyReleaseInputs({ repoRoot: data.root, inputs, history: { complete: true, versions: ["0.0.1"] } }),
    ).rejects.toThrow("do not match")
    await expect(
      verifyReleaseInputs({ repoRoot: data.root, inputs, history: { complete: true, versions: [inputs.version] } }),
    ).rejects.toThrow("already allocated")
    await writeFile(path.join(data.root, "LICENSE"), "new committed source\n")
    commit(data.root)
    await expect(verifyReleaseInputs({ repoRoot: data.root, inputs, history })).rejects.toThrow("do not match")
  })

  test("rejects dirty canonical provenance and a changed artifact in a committed checkout", async () => {
    const data = await fixture()
    data.manifest.dirty = true
    await data.manifestCommit()
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("clean, pinned source")
    data.manifest.dirty = false
    await data.manifestCommit()
    await writeFile(
      path.join(data.root, "packages/physicalsystems/vendor/operator-service.mjs"),
      "unexpected program\n",
    )
    commit(data.root)
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("digest mismatch")
  })

  test("rejects traversal in artifact inventory and undeclared ignored files", async () => {
    const data = await fixture()
    data.manifest.artifacts["../private.txt"] = digest("private")
    await data.manifestCommit()
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("Unsafe")
    delete data.manifest.artifacts["../private.txt"]
    await data.manifestCommit()
    await writeFile(path.join(data.root, ".gitignore"), "secret.txt\n")
    commit(data.root)
    await writeFile(path.join(data.root, "packages/physicalsystems/vendor/secret.txt"), "must not enter artifacts")
    expect(git(data.root, "status", "--porcelain")).toBe("")
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("Unexpected operator vendor files")
  })

  test("rejects artifact symlinks including a directory redirect", async () => {
    const data = await fixture()
    const skills = path.join(data.root, "packages/physicalsystems/vendor/skills")
    await rm(skills, { recursive: true })
    await symlink(path.join(data.root, "release"), skills, process.platform === "win32" ? "junction" : "dir")
    commit(data.root)
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("Symlink")
  })

  test("pins both compressed and decoded catalog bytes and rejects an empty or corrupt snapshot", async () => {
    const data = await fixture()
    const inputs = await prepareReleaseInputs(data.input)
    const snapshot = path.join(data.root, "release/models.dev-api.json.gz")
    await writeFile(snapshot, gzipSync(JSON.stringify({ replacement: { models: {} } })))
    commit(data.root)
    await expect(verifyReleaseInputs({ repoRoot: data.root, inputs, history })).rejects.toThrow("do not match")
    await writeFile(snapshot, gzipSync("{}"))
    commit(data.root)
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("empty")
    await writeFile(snapshot, "not gzip")
    commit(data.root)
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow()
  })

  test("rejects unpinned build tools, mutable upstream references and enabled publication", async () => {
    const data = await fixture()
    await writeFile(
      path.join(data.root, "packages/desktop/package.json"),
      JSON.stringify({ devDependencies: { electron: "^42.3.3", "electron-builder": "26.15.2" } }),
    )
    commit(data.root)
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("exactly pinned")
    data.fixturePolicy.upstream.revision = "main"
    await data.policyCommit()
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("immutable")
    data.fixturePolicy.publication = true
    await data.policyCommit()
    await expect(prepareReleaseInputs(data.input)).rejects.toThrow("policy")
  })
})
