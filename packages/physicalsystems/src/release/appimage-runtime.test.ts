// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { appImageRuntimeDigests, bindAppImageElectron, prepareAppImageRuntime } from "./appimage-runtime"
import { qualifyAppImageReinstall } from "./appimage-reinstall"
import type { ReinstallObservation } from "./installed-reinstall"
import { payloadFingerprint, sha256File } from "./qualification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  // Deliberately inert bytes and fake process observations. Never executed.
  const parent = await mkdtemp(join(tmpdir(), "ar-fixture-"))
  roots.push(parent)
  const root = join(parent, "owned")
  const temporary = join(parent, "ps-owned")
  await mkdir(root, { mode: 0o700 })
  await mkdir(temporary, { mode: 0o700 })
  const bytes = Buffer.alloc(300000)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes)
  Buffer.from([0x41, 0x49, 0x02]).copy(bytes, 8)
  Buffer.from("INERT TEST FIXTURE\0appimage-version\0effcebc\0--appimage-extract-and-run\0/appimage_extracted_\0").copy(
    bytes,
    16,
  )
  const artifact = join(root, "extractable.AppImage")
  const source = join(root, "source-fixture.AppImage")
  await writeFile(artifact, bytes, { mode: 0o700 })
  await writeFile(source, bytes, { mode: 0o600 })
  const input = {
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
      GITHUB_RUN_ID: "12345",
      RUNNER_TEMP: parent,
    },
    root,
    temporary,
    artifact,
    artifactSha256: await sha256File(artifact),
    kind: "candidate" as const,
  }
  return { input, source, bytes }
}

test("runtime plan uses whole-artifact MD5 only as an exact cache path and SHA256 as its anchor", async () => {
  const f = await fixture()
  const plan = await prepareAppImageRuntime(f.input)
  expect(plan.cache).toBe(
    join(f.input.temporary, "appimage_extracted_" + createHash("md5").update(f.bytes).digest("hex")),
  )
  expect(plan.arguments).toEqual(["--appimage-extract-and-run"])
  expect(plan.profile.text).toContain(`"${plan.executable}" flags=(unconfined)`)
  expect(plan.profile.text).not.toMatch(/[?*]/)
  expect(plan.profile.text).not.toContain("--no-sandbox")
  await plan.beforeLaunch()
  expect(await plan.afterShutdown({ applicationExited: true, descendantsExited: true, runtimeExitCode: 0 })).toEqual({
    originalArtifactRuntime: true,
    mode: "extract-and-run",
    runtimeRemovedExtraction: true,
    fuseTested: false,
    doubleClickTested: false,
  })
  await writeFile(f.input.artifact, "changed artifact")
  await expect(plan.beforeLaunch()).rejects.toThrow(/APPIMAGE_RUNTIME_(?:UNSUPPORTED|ARTIFACT_CHANGED)/)
})

test("runtime planning rejects foreign parents, unknown runtime, bad anchors and symlink artifacts", async () => {
  const f = await fixture()
  await expect(prepareAppImageRuntime({ ...f.input, env: { ...f.input.env, CI: "false" } })).rejects.toThrow(
    "REQUIRES_DISPOSABLE_RUNNER",
  )
  await expect(prepareAppImageRuntime({ ...f.input, temporary: tmpdir() })).rejects.toThrow(
    "APPIMAGE_RUNTIME_PATH_INVALID",
  )
  await expect(appImageRuntimeDigests(f.input.artifact, "a".repeat(64))).rejects.toThrow(
    "APPIMAGE_RUNTIME_ARTIFACT_CHANGED",
  )
  const unknown = Buffer.from(f.bytes)
  unknown.fill(0, 16, 150)
  await writeFile(f.input.artifact, unknown)
  await expect(appImageRuntimeDigests(f.input.artifact, await sha256File(f.input.artifact))).rejects.toThrow(
    "APPIMAGE_RUNTIME_UNSUPPORTED",
  )
  await rm(f.input.artifact)
  await symlink(f.source, f.input.artifact)
  await expect(appImageRuntimeDigests(f.input.artifact, f.input.artifactSha256)).rejects.toThrow(
    "APPIMAGE_RUNTIME_ARTIFACT_CHANGED",
  )
})

test("preexisting caches and uncertain shutdown remain retained, never deleted by the helper", async () => {
  const f = await fixture()
  const plan = await prepareAppImageRuntime(f.input)
  await mkdir(plan.cache)
  await writeFile(join(plan.cache, "retained"), "inert")
  await expect(plan.beforeLaunch()).rejects.toThrow("APPIMAGE_RUNTIME_CACHE_NOT_EMPTY")
  for (const proof of [
    { applicationExited: false, descendantsExited: true, runtimeExitCode: 0 },
    { applicationExited: true, descendantsExited: false, runtimeExitCode: 0 },
    { applicationExited: true, descendantsExited: true, runtimeExitCode: 1 },
    { applicationExited: true, descendantsExited: true, runtimeExitCode: 0 },
  ])
    await expect(plan.afterShutdown(proof)).rejects.toThrow("APPIMAGE_RUNTIME_CLEANUP_UNCONFIRMED")
  expect(await readFile(join(plan.cache, "retained"), "utf8")).toBe("inert")
})

test("only one same-UID direct runtime child with the actual expected payload may own the Electron attachment", async () => {
  const f = await fixture()
  const plan = await prepareAppImageRuntime(f.input)
  await mkdir(join(plan.cache, "resources"), { recursive: true })
  await writeFile(plan.executable, "inert executable fixture")
  await writeFile(join(plan.cache, "resources", "app.asar"), "inert resource fixture")
  const payload = await payloadFingerprint(plan.executable)
  const uid = process.getuid!()
  const processes = [
    { pid: 100, ppid: 1, uid, executable: plan.artifact },
    { pid: 101, ppid: 100, uid, executable: plan.executable },
  ]
  const input = { runtimePid: 100, uid, plan, payloadSha256: payload.sha256, processes }
  expect(await bindAppImageElectron(input)).toBe(101)
  for (const changed of [
    [processes[0], { ...processes[1], uid: uid + 1 }],
    [processes[0], { ...processes[1], ppid: 2 }],
    [{ ...processes[0], executable: "/foreign/runtime" }, processes[1]],
    [...processes, { ...processes[1], pid: 102 }],
  ])
    await expect(bindAppImageElectron({ ...input, processes: changed })).rejects.toThrow(
      "APPIMAGE_RUNTIME_OWNER_UNCONFIRMED",
    )
  await writeFile(join(plan.cache, "resources", "app.asar"), "changed resources")
  await expect(bindAppImageElectron(input)).rejects.toThrow("APPIMAGE_RUNTIME_PAYLOAD_CHANGED")
})

const before = (): ReinstallObservation => ({
  projectId: "project-fixture",
  sessionId: "ses_fixture",
  experimentId: "experiment-fixture",
  phase: "COMPLETED",
  trialCount: 3,
  trialsSha256: "a".repeat(64),
  transcriptSha256: "b".repeat(64),
  pinchZoomEnabled: true,
})
async function replacementFixture() {
  const f = await fixture()
  let launches = 0
  const input: Parameters<typeof qualifyAppImageReinstall>[0] = {
    env: f.input.env,
    root: f.input.root,
    artifact: f.source,
    artifactSha256: f.input.artifactSha256,
    runnable: f.input.artifact,
    before: before(),
    replacementState: { unconfirmed: false },
    shutdown: { applicationExited: true, descendantsExited: true, runtimeCacheRemoved: true },
    relaunch: async () => {
      launches++
      expect(input.replacementState.unconfirmed).toBe(false)
      expect(await readFile(input.runnable)).toEqual(f.bytes)
      return { observation: before(), applicationExited: true, descendantsExited: true, runtimeCacheRemoved: true }
    },
  }
  return { input, launches: () => launches }
}

test("portable replacement recopy preserves the profile evidence and never claims installed package or FUSE behavior", async () => {
  const f = await replacementFixture()
  const result = await qualifyAppImageReinstall(f.input)
  expect(f.launches()).toBe(1)
  expect(result.scope).toBe("portable-file-replacement")
  expect(result.preservedTranscript).toBe(true)
  expect(result.packageRegistrationTested).toBe(false)
  expect(result.upgradeTested).toBe(false)
  expect(JSON.stringify(result)).not.toContain("PASS")
})

test("portable replacement refuses uncertain preflight, altered state and unconfirmed final native shutdown", async () => {
  for (const variation of ["application", "descendant", "cache", "pending"]) {
    const f = await replacementFixture()
    if (variation === "application") f.input.shutdown.applicationExited = false
    if (variation === "descendant") f.input.shutdown.descendantsExited = false
    if (variation === "cache") f.input.shutdown.runtimeCacheRemoved = false
    if (variation === "pending") f.input.replacementState.unconfirmed = true
    await expect(qualifyAppImageReinstall(f.input)).rejects.toThrow("APPIMAGE_REINSTALL_SHUTDOWN_UNCONFIRMED")
    expect(f.launches()).toBe(0)
    expect(await sha256File(f.input.runnable)).toBe(f.input.artifactSha256)
  }
  for (const variation of ["state", "cache", "mutable"]) {
    const f = await replacementFixture()
    f.input.relaunch = async () => {
      const value = before()
      if (variation !== "cache") value.trialCount = 4 as 3
      if (variation === "mutable") Object.assign(f.input.before, value)
      return {
        observation: value,
        applicationExited: true,
        descendantsExited: true,
        runtimeCacheRemoved: variation !== "cache",
      }
    }
    await expect(qualifyAppImageReinstall(f.input)).rejects.toThrow(
      /APPIMAGE_REINSTALL_(?:STATE_CHANGED|SHUTDOWN_UNCONFIRMED)/,
    )
  }
})
