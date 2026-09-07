// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { PassThrough, Writable } from "node:stream"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startLinuxSecretService } from "./linux-secret-service"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function subprocessFixture(
  options: {
    busOwner?: number
    serviceOwner?: number
    existing?: boolean
    locked?: boolean
    refuse?: boolean
    hangProbe?: boolean
    retainKeyring?: boolean
    killError?: boolean
    failSpawn?: boolean
    oversized?: boolean
  } = {},
) {
  let nextPid = 4100
  let busPid = 0
  let keyringPid = 0
  const calls: {
    file: string
    args: string[]
    options: SpawnOptions
    pid: number
    signals: unknown[]
    detached: boolean
    passwordBytes: number
    passwordInArgs: boolean
  }[] = []
  const factory = ((file: string, args: string[], config: SpawnOptions) => {
    const pid = ++nextPid
    const call = {
      file,
      args,
      options: config,
      pid,
      signals: [] as unknown[],
      detached: false,
      passwordBytes: 0,
      passwordInArgs: false,
    }
    calls.push(call)
    if (file.endsWith("dbus-daemon")) busPid = pid
    if (file.endsWith("gnome-keyring-daemon")) keyringPid = pid
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: null })
    const finish = (code: number | null, signal: NodeJS.Signals | null = null) => {
      Object.assign(child, { exitCode: code, signalCode: signal })
      child.stdout?.push(null)
      child.emit("exit", code, signal)
      child.emit("close", code, signal)
    }
    child.stdin = new Writable({
      write(chunk: Buffer, _encoding, done) {
        call.passwordBytes += chunk.length
        call.passwordInArgs ||= JSON.stringify({ args, env: config.env }).includes(chunk.toString())
        done()
      },
    })
    child.kill = (signal = "SIGTERM") => {
      call.signals.push(signal)
      if (options.killError && file.endsWith("gnome-keyring-daemon")) {
        queueMicrotask(() => child.emit("error", new Error("PRIVATE-KILL-TRAP")))
        return false
      }
      if (options.retainKeyring && file.endsWith("gnome-keyring-daemon")) return false
      queueMicrotask(() => finish(null, signal as NodeJS.Signals))
      return true
    }
    child.unref = () => {
      call.detached = true
    }
    queueMicrotask(() => {
      if (options.failSpawn && file.endsWith("dbus-daemon")) {
        Object.assign(child, { pid: undefined })
        child.emit("error", new Error("PRIVATE-SPAWN-TRAP"))
        return
      }
      if (!file.endsWith("gdbus") || options.hangProbe) return
      if (options.refuse) {
        finish(1)
        return
      }
      const method = args[args.indexOf("--method") + 1]
      const result = options.oversized
        ? "PRIVATE-OUTPUT-TRAP".repeat(100)
        : method.endsWith("NameHasOwner")
          ? `(${options.existing ? "true" : "false"},)`
          : method.endsWith("Properties.Get")
            ? `(<${options.locked ? "true" : "false"}>,)`
            : `(uint32 ${args.at(-1) === "org.freedesktop.DBus" ? (options.busOwner ?? busPid) : (options.serviceOwner ?? keyringPid)},)`
      child.stdout?.emit("data", Buffer.from(result + "\n"))
      finish(0)
    })
    return child
  }) as typeof spawn
  return { spawn: factory, calls }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ps-secret-fixture-")))
  roots.push(root)
  const evidence = join(root, "evidence")
  await mkdir(evidence)
  // This fake environment is passed only to a helper whose every subprocess is
  // replaced above. process.env and the laptop's bus/keyring are never changed.
  const env = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_RUN_ID: "12345",
    RUNNER_TEMP: root,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/private-ambient-bus",
    GNOME_KEYRING_CONTROL: "/private-ambient-keyring",
    SECRET_TRAP: "private-credential-trap",
  }
  return { root, evidence, env }
}
const fast = { readinessMs: 120, probeMs: 25, shutdownMs: 20 }

test.skipIf(process.platform !== "linux")(
  "private bus and keyring ownership persist across app restarts without exposing passwords",
  async () => {
    const f = await fixture()
    const child = subprocessFixture()
    const service = await startLinuxSecretService(f.env, f.evidence, { ...fast, spawn: child.spawn })
    expect(Object.keys(service.environment).sort()).toEqual([
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_CURRENT_DESKTOP",
      "XDG_RUNTIME_DIR",
    ])
    const owned = service.environment.XDG_RUNTIME_DIR.replace(/\/runtime$/, "")
    expect((await lstat(owned)).mode & 0o777).toBe(0o700)
    expect(Buffer.byteLength(owned + "/bus")).toBeLessThan(108)
    expect(service.environment.XDG_CURRENT_DESKTOP).toBe("GNOME")
    for (const call of child.calls) {
      expect(call.options.env?.SECRET_TRAP).toBeUndefined()
      expect(call.options.env?.GNOME_KEYRING_CONTROL).toBeUndefined()
      expect(call.options.env?.DBUS_SESSION_BUS_ADDRESS).toBe(service.environment.DBUS_SESSION_BUS_ADDRESS)
      expect(call.options.env?.DBUS_SYSTEM_BUS_ADDRESS).toBe(`unix:path=${owned}/absent-system-bus`)
      expect(call.args).not.toContain("--system")
    }
    const bus = child.calls.find((call) => call.file.endsWith("dbus-daemon"))!
    const keyring = child.calls.find((call) => call.file.endsWith("gnome-keyring-daemon"))!
    expect(bus.args).toContain("--nofork")
    expect(await readFile(join(owned, "session.conf"), "utf8")).not.toContain("servicedir")
    expect(keyring.args).toContain("--foreground")
    expect(keyring.args).toContain("--components=secrets")
    expect(keyring.args).not.toContain("--replace")
    expect(keyring.passwordBytes).toBeGreaterThan(32)
    expect(keyring.passwordInArgs).toBe(false)
    // Reusing the returned environment across three app phases creates no daemon
    // or ambient-service lookup. Only final confirmed lifecycle proof closes it.
    for (let phase = 0; phase < 3; phase++)
      expect(service.environment.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${owned}/bus`)
    expect(bus.signals).toEqual([])
    expect(keyring.signals).toEqual([])
    expect(await service.close({ applicationExited: true, descendantsExited: true })).toEqual({ status: "STOPPED" })
    expect(keyring.signals).toEqual(["SIGTERM"])
    expect(bus.signals).toEqual(["SIGTERM"])
    expect(await readdir(f.root)).toEqual(["evidence"])
  },
)

test.skipIf(process.platform !== "linux")(
  "unconfirmed app cleanup retains services and private directories without signals",
  async () => {
    const f = await fixture()
    const child = subprocessFixture()
    const service = await startLinuxSecretService(f.env, f.evidence, { ...fast, spawn: child.spawn })
    expect(await service.close({ applicationExited: true, descendantsExited: false })).toEqual({ status: "RETAINED" })
    expect(child.calls.flatMap((call) => call.signals)).toEqual([])
    expect(child.calls.every((call) => call.detached)).toBe(true)
    expect((await readdir(f.root)).length).toBe(2)
  },
)

test.skipIf(process.platform !== "linux")(
  "wrong bus/service owners and existing Secret Service cannot be reused",
  async () => {
    for (const variation of [{ busOwner: 9999 }, { serviceOwner: 9999 }, { existing: true }]) {
      const f = await fixture()
      const child = subprocessFixture(variation)
      await expect(startLinuxSecretService(f.env, f.evidence, { ...fast, spawn: child.spawn })).rejects.toThrow(
        /LINUX_SECRET_SERVICE_(?:BUS_OWNER_MISMATCH|SERVICE_OWNER_MISMATCH|EXISTING_SERVICE)/,
      )
      expect(await readdir(f.root)).toEqual(["evidence"])
      if (variation.existing) expect(child.calls.some((call) => call.file.endsWith("gnome-keyring-daemon"))).toBe(false)
    }
  },
)

test.skipIf(process.platform !== "linux")(
  "readiness, subprocess output and service shutdown are bounded and fail privately",
  async () => {
    for (const variation of [
      { locked: true },
      { refuse: true },
      { hangProbe: true },
      { failSpawn: true },
      { oversized: true },
    ]) {
      const f = await fixture()
      const child = subprocessFixture(variation)
      const started = Date.now()
      try {
        await startLinuxSecretService(f.env, f.evidence, { ...fast, spawn: child.spawn })
        throw new Error("Expected rejection")
      } catch (error) {
        expect(String(error)).toContain("LINUX_SECRET_SERVICE_")
        expect(String(error)).not.toContain("PRIVATE-")
      }
      expect(Date.now() - started).toBeLessThan(1000)
      expect(await readdir(f.root)).toEqual(["evidence"])
    }
    const f = await fixture()
    const child = subprocessFixture({ retainKeyring: true })
    const service = await startLinuxSecretService(f.env, f.evidence, { ...fast, spawn: child.spawn })
    await expect(service.close({ applicationExited: true, descendantsExited: true })).rejects.toThrow(
      "CLEANUP_UNCONFIRMED",
    )
    expect((await readdir(f.root)).length).toBe(2)
    expect(child.calls.find((call) => call.file.endsWith("dbus-daemon"))?.signals).toEqual([])
  },
)

test("service setup refuses a local environment before subprocess creation", async () => {
  const f = await fixture()
  const child = subprocessFixture()
  await expect(
    startLinuxSecretService({ ...f.env, CI: "false" }, f.evidence, { ...fast, spawn: child.spawn }),
  ).rejects.toThrow("DISPOSABLE_RUNNER")
  expect(child.calls).toHaveLength(0)
})

test.skipIf(process.platform !== "linux")(
  "a kill error with an owned PID does not prove that the service exited",
  async () => {
    const f = await fixture()
    const child = subprocessFixture({ killError: true })
    const service = await startLinuxSecretService(f.env, f.evidence, { ...fast, spawn: child.spawn })
    await expect(service.close({ applicationExited: true, descendantsExited: true })).rejects.toThrow(
      "LINUX_SECRET_SERVICE_CLEANUP_UNCONFIRMED",
    )
    expect((await readdir(f.root)).length).toBe(2)
    expect(child.calls.find((call) => call.file.endsWith("dbus-daemon"))?.signals).toEqual([])
    expect(child.calls.every((call) => call.detached)).toBe(true)
  },
)
