// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { unlinkSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  observePartialWindowsPayload,
  runNativeUpgradeInstaller,
  stopOwnedWindowsInstaller,
} from "./native-upgrade-process"
import { payloadFingerprint, sha256File } from "./qualification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("partial-copy observation distinguishes absent, incomplete, preallocated and complete target bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "upgrade-partial-bytes-fixture-"))
  roots.push(root)
  const target = join(root, "reference")
  const actual = join(root, "actual")
  const bytes = Buffer.alloc(256 * 1024, 91)
  bytes.fill(17, bytes.length - 64 * 1024)
  await writeFile(target, bytes)
  expect(await observePartialWindowsPayload(actual, target, bytes.length)).toBe("ABSENT")
  await writeFile(actual, bytes.subarray(0, 64 * 1024))
  expect(await observePartialWindowsPayload(actual, target, bytes.length)).toBe("PARTIAL")
  const allocated = Buffer.alloc(bytes.length)
  bytes.copy(allocated, 0, 0, 64 * 1024)
  await writeFile(actual, allocated)
  expect(await observePartialWindowsPayload(actual, target, bytes.length)).toBe("PARTIAL")
  await writeFile(actual, bytes)
  expect(await observePartialWindowsPayload(actual, target, bytes.length)).toBe("UNCONFIRMED")
  await writeFile(actual, Buffer.alloc(bytes.length, 33))
  expect(await observePartialWindowsPayload(actual, target, bytes.length)).toBe("UNCONFIRMED")
})

test("the owned installer runner uses exact bounded native command arguments and waits for close", async () => {
  // Fake subprocess emits no native install activity; files are inert fixtures.
  const temporary = await mkdtemp(join(tmpdir(), "upgrade-process-fixture-"))
  roots.push(temporary)
  const root = join(temporary, "owned")
  await mkdir(root)
  const artifact = join(root, "physical-systems-desktop-0.1.0-beta.2-linux-x64.deb")
  await writeFile(artifact, "INERT PROCESS TEST FIXTURE")
  const input = {
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
      GITHUB_RUN_ID: "12345",
      RUNNER_TEMP: temporary,
    },
    root,
    format: "deb" as const,
    action: "install" as const,
    artifact,
    artifactSha256: await sha256File(artifact),
    version: "0.1.0-beta.2",
    installation: "/opt/Physical Systems",
    baselinePayloadSha256: "a".repeat(64),
    targetPayloadSha256: "b".repeat(64),
    descendants: async () => [],
  }
  const started = Promise.withResolvers<void>()
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid: 123456789, kill: () => false, unref: () => child })
  const running = runNativeUpgradeInstaller(input, {
    platform: "linux",
    spawn: (file, args, options) => {
      expect(file).toBe("/usr/bin/sudo")
      expect(args).toEqual(["-n", "/usr/bin/dpkg", "--install", artifact])
      expect(options.shell).toBe(false)
      expect(options.stdio).toBe("ignore")
      started.resolve()
      return child
    },
  })
  await started.promise
  child.emit("exit", 0)
  let resolved = false
  void running.then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(resolved).toBe(false)
  child.emit("close", 0)
  expect(await running).toEqual({ installerExited: true, descendantsExited: true })
  await expect(
    runNativeUpgradeInstaller(
      { ...input, env: { ...input.env, RUNNER_ENVIRONMENT: "self-hosted" } },
      {
        platform: "linux",
        spawn: () => {
          throw new Error("MUST NOT SPAWN")
        },
      },
    ),
  ).rejects.toThrow("PUBLIC_QUALIFICATION_REQUIRES_DISPOSABLE_RUNNER")
})

test("installer spawn failures and timeout requests never become confirmed shutdown or retry authority", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "upgrade-process-failure-fixture-"))
  roots.push(temporary)
  const root = join(temporary, "owned")
  await mkdir(root)
  const artifact = join(root, "physical-systems-desktop-0.1.0-beta.2-linux-x64.deb")
  await writeFile(artifact, "INERT PROCESS FAILURE TEST FIXTURE")
  const input = {
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
      GITHUB_RUN_ID: "12345",
      RUNNER_TEMP: temporary,
    },
    root,
    format: "deb" as const,
    action: "install" as const,
    artifact,
    artifactSha256: await sha256File(artifact),
    version: "0.1.0-beta.2",
    installation: "/opt/Physical Systems",
    baselinePayloadSha256: "a".repeat(64),
    targetPayloadSha256: "b".repeat(64),
    descendants: async () => [],
  }
  for (const mode of ["error", "timeout"] as const) {
    let kills = 0
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, {
      pid: 123456789,
      kill: () => {
        kills++
        child.emit("close", null)
        return true
      },
      unref: () => child,
    })
    await expect(
      runNativeUpgradeInstaller(input, {
        platform: "linux",
        timeoutMs: 5,
        spawn: () => {
          if (mode === "error") queueMicrotask(() => child.emit("error", new Error("PRIVATE SIGNED URL TRAP")))
          return child
        },
      }),
    ).rejects.toThrow(mode === "error" ? "PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED" : "PUBLIC_UPGRADE_INSTALLER_TIMEOUT")
    expect(kills).toBe(1)
  }
})

test("Windows interruption selects only the owned live PID tree and waits for native helper close", async () => {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid: 123456789, exitCode: null, signalCode: null })
  const helper = new EventEmitter() as ChildProcess
  Object.assign(helper, { kill: () => true, unref: () => helper })
  let called = false
  const stop = stopOwnedWindowsInstaller(child, {
    env: { SystemRoot: "C:\\Windows" },
    spawn: (file, args, options) => {
      called = true
      expect(file).toBe("C:\\Windows\\System32\\taskkill.exe")
      expect(args).toEqual(["/PID", "123456789", "/T", "/F"])
      expect(options.shell).toBe(false)
      expect(options.stdio).toBe("ignore")
      return helper
    },
  })
  expect(called).toBe(true)
  let done = false
  void stop.then(() => {
    done = true
  })
  helper.emit("exit", 0)
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done).toBe(false)
  helper.emit("close", 0)
  await stop
  Object.assign(child, { exitCode: 0 })
  await expect(
    stopOwnedWindowsInstaller(child, {
      env: { SystemRoot: "C:\\Windows" },
      spawn: () => {
        throw new Error("must not select an exited PID")
      },
    }),
  ).rejects.toThrow("INTERRUPTION_UNCONFIRMED")
})

test.skipIf(process.platform !== "win32")(
  "slow native descendant inspection cannot block the Windows partial-copy watcher",
  async () => {
    // Run by the Windows source regression step with inert files/fake processes.
    const temporary = await mkdtemp(join(tmpdir(), "upgrade-watch-fixture-"))
    roots.push(temporary)
    const root = join(temporary, "owned")
    const installation = join(root, "payload")
    await mkdir(join(installation, "resources"), { recursive: true })
    const executable = join(installation, "Physical Systems.exe")
    const actual = join(installation, "resources", "app.asar")
    const artifact = join(root, "physical-systems-desktop-0.1.0-beta.2-windows-x64.exe")
    const target = join(root, "target-reference.asar")
    const targetBytes = Buffer.alloc(256 * 1024, 22)
    await writeFile(executable, "INERT EXECUTABLE")
    await writeFile(actual, "INERT BASELINE RESOURCE")
    await writeFile(artifact, "INERT INSTALLER")
    await writeFile(target, targetBytes)
    const parent = new EventEmitter() as ChildProcess
    let parentClosed = false
    const closeParent = () => {
      if (parentClosed) return
      parentClosed = true
      parent.emit("close", 1)
    }
    Object.assign(parent, {
      pid: 123456789,
      exitCode: null,
      signalCode: null,
      kill: () => {
        queueMicrotask(closeParent)
        return true
      },
      unref: () => parent,
    })
    let queries = 0
    let queriesFinished = 0
    let interruptedBeforeQuery = false
    const slowQuery = Promise.withResolvers<void>()
    let queryDeadline: ReturnType<typeof setTimeout> | undefined
    const observations: string[] = []
    let partialWritten = false
    let helperClosed: Promise<void> | undefined
    const running = runNativeUpgradeInstaller(
      {
        env: {
          CI: "true",
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
          RUNNER_OS: "Windows",
          GITHUB_RUN_ID: "12345",
          RUNNER_TEMP: temporary,
          SystemRoot: "C:\\Windows",
        },
        root,
        format: "nsis",
        action: "interrupt",
        artifact,
        artifactSha256: await sha256File(artifact),
        version: "0.1.0-beta.2",
        installation,
        baselinePayloadSha256: (await payloadFingerprint(executable)).sha256,
        targetPayloadSha256: "e".repeat(64),
        targetAsarReference: { file: target, bytes: targetBytes.length, sha256: await sha256File(target) },
        descendants: async () => {
          queries++
          if (queries === 1) {
            // A broken watcher must fail inside the fixture's normal test
            // budget and release its fake process, rather than hang forever.
            queryDeadline = setTimeout(() => slowQuery.reject(new Error("INERT_WATCHER_DID_NOT_INTERRUPT")), 2000)
            try {
              await slowQuery.promise
            } finally {
              clearTimeout(queryDeadline)
            }
          }
          queriesFinished++
          return []
        },
      },
      {
        timeoutMs: 3000,
        observePayload: async (...args) => {
          // The first real ABSENT result returns to the watcher before the
          // next call writes partial bytes. No timer or background I/O can
          // hide the removal transition from a slow hosted Windows runner.
          if (observations.at(-1) === "ABSENT" && !partialWritten) {
            await writeFile(actual, targetBytes.subarray(0, 64 * 1024))
            partialWritten = true
          }
          const observation = await observePartialWindowsPayload(...args)
          observations.push(observation)
          return observation
        },
        spawn: (file, args) => {
          if (file === artifact) {
            // Baseline verification has finished; remove its resource before
            // the watcher starts, while the fake installer remains alive.
            unlinkSync(actual)
            return parent
          }
          expect(file).toBe("C:\\Windows\\System32\\taskkill.exe")
          expect(args).toEqual(["/PID", "123456789", "/T", "/F"])
          interruptedBeforeQuery = queries > queriesFinished
          slowQuery.resolve()
          const helper = new EventEmitter() as ChildProcess
          Object.assign(helper, { kill: () => false, unref: () => helper })
          helperClosed = new Promise((resolve) => helper.once("close", () => resolve()))
          queueMicrotask(() => {
            closeParent()
            helper.emit("close", 0)
          })
          return helper
        },
      },
    )
    try {
      const result = await running
      expect(observations).toEqual(["ABSENT", "PARTIAL"])
      expect(interruptedBeforeQuery).toBe(true)
      expect(queriesFinished).toBe(2)
      expect(result).toMatchObject({
        kind: "windows-partial-payload-copy",
        installerExited: true,
        descendantsExited: true,
        targetInstallationComplete: false,
      })
    } finally {
      clearTimeout(queryDeadline)
      slowQuery.resolve()
      closeParent()
      await running.catch(() => {})
      await helperClosed
    }
  },
)
