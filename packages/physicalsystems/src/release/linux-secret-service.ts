// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { allocateLinuxQualificationTemporary } from "./linux-temporary"

const failure = (code: string) => new Error(`LINUX_SECRET_SERVICE_${code}`)

/** Test injection replaces subprocess creation only; the disposable-runner and
 * private-directory checks remain active. No native service runs in unit tests. */
export async function startLinuxSecretService(
  env: NodeJS.ProcessEnv,
  evidenceRoot: string,
  options: { spawn?: typeof spawn; readinessMs?: number; probeMs?: number; shutdownMs?: number } = {},
) {
  const readinessMs = options.readinessMs ?? 10000
  const probeMs = options.probeMs ?? 1500
  const shutdownMs = options.shutdownMs ?? 3000
  if (
    [
      [readinessMs, 10000],
      [probeMs, 1500],
      [shutdownMs, 3000],
    ].some(([value, maximum]) => !Number.isInteger(value) || value < 1 || value > maximum)
  )
    throw failure("TIMEOUT_INVALID")
  const temporary = await allocateLinuxQualificationTemporary(env, evidenceRoot)
  const root = temporary.path
  const tasks: ReturnType<typeof managed>[] = []
  let exposed = false
  let removed = false
  const launch = options.spawn ?? spawn
  const address = `unix:path=${join(root, "bus")}`
  const environment = Object.freeze({
    DBUS_SESSION_BUS_ADDRESS: address,
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_CURRENT_DESKTOP: "GNOME",
  })
  const privateEnv = {
    ...environment,
    // Never discover the host's system bus, user configuration or keyring.
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(root, "absent-system-bus")}`,
    HOME: join(root, "home"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
    PATH: join(root, "empty-path"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  }
  const create = (file: string, args: string[], mode: "daemon" | "unlock" | "probe") => {
    const child = launch(file, args, {
      cwd: root,
      env: privateEnv,
      stdio: [mode === "unlock" ? "pipe" : "ignore", mode === "probe" ? "pipe" : "ignore", "ignore"],
    })
    const task = managed(child)
    tasks.push(task)
    return task
  }
  const stop = async (task: ReturnType<typeof managed>) => {
    if (!task.closed) task.child.kill("SIGTERM")
    if (
      !(await bounded(
        task.done.then(() => true),
        shutdownMs,
      ))
    )
      throw failure("CLEANUP_UNCONFIRMED")
  }
  const close = async (proof: { applicationExited: boolean; descendantsExited: boolean }) => {
    if (removed) return { status: "STOPPED" as const }
    if (proof.applicationExited !== true || proof.descendantsExited !== true) {
      for (const task of tasks) task.detach()
      return { status: "RETAINED" as const }
    }
    try {
      // Stop owned probes and the keyring before the bus; never use killall or
      // signal a PID merely reported by an unexpected bus service.
      for (const task of [...tasks].reverse()) await stop(task)
      await temporary.cleanup(proof)
      removed = true
      return { status: "STOPPED" as const }
    } catch {
      for (const task of tasks) task.detach()
      throw failure("CLEANUP_UNCONFIRMED")
    }
  }
  const call = async (method: string, args: string[], limit: number, secret = false) => {
    const task = create(
      "/usr/bin/gdbus",
      [
        "call",
        "--address",
        address,
        "--dest",
        secret ? "org.freedesktop.secrets" : "org.freedesktop.DBus",
        "--object-path",
        secret ? "/org/freedesktop/secrets/collection/login" : "/org/freedesktop/DBus",
        "--method",
        method,
        ...args,
      ],
      "probe",
    )
    let output = ""
    let oversized = false
    task.child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 1024) oversized = true
      if (!oversized) output += chunk.toString()
    })
    if (
      !(await bounded(
        task.done.then(() => true),
        limit,
      ))
    )
      await stop(task)
    if (task.failed || task.child.exitCode !== 0 || oversized) return
    return output.trim()
  }
  let bus: ReturnType<typeof managed> | undefined
  let keyring: ReturnType<typeof managed> | undefined
  const wait = async (probe: (remaining: number) => Promise<boolean>, deadline: number) => {
    while (Date.now() < deadline) {
      if (bus?.closed || keyring?.closed) throw failure("STARTUP_FAILED")
      if (await probe(Math.min(probeMs, Math.max(1, deadline - Date.now())))) return
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
    }
    throw failure("READINESS_UNCONFIRMED")
  }
  try {
    // D-Bus address/XML interpolation uses only this restricted, canonical CI
    // path. The shared allocator also enforces Linux Unix-socket length limits.
    if (!/^[A-Za-z0-9_./-]+$/.test(root)) throw failure("PATH_INVALID")
    for (const directory of ["home", "data", "config", "cache", "runtime", "control", "tmp", "empty-path"])
      await mkdir(join(root, directory), { mode: 0o700 })
    const config = join(root, "session.conf")
    await writeFile(
      config,
      `<busconfig><type>session</type><listen>${address}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>\n`,
      { mode: 0o600, flag: "wx" },
    )
    // No service directories or activation are configured: the new bus cannot
    // autostart or reuse a desktop-wide Secret Service.
    bus = create("/usr/bin/dbus-daemon", [`--config-file=${config}`, "--nofork", "--nopidfile", "--nosyslog"], "daemon")
    const deadline = Date.now() + readinessMs
    await wait(async (remaining) => {
      const owner = await call("org.freedesktop.DBus.GetConnectionUnixProcessID", ["org.freedesktop.DBus"], remaining)
      if (!owner) return false
      if (owner !== `(uint32 ${bus!.child.pid},)`) throw failure("BUS_OWNER_MISMATCH")
      return true
    }, deadline)
    const existing = await call("org.freedesktop.DBus.NameHasOwner", ["org.freedesktop.secrets"], probeMs)
    if (existing !== "(false,)") throw failure("EXISTING_SERVICE")
    keyring = create(
      "/usr/bin/gnome-keyring-daemon",
      ["--foreground", "--components=secrets", "--unlock", `--control-directory=${join(root, "control")}`],
      "unlock",
    )
    if (!keyring.child.stdin) throw failure("STARTUP_FAILED")
    const password = Buffer.from(randomBytes(32).toString("base64"))
    try {
      const written = new Promise<boolean>((resolve) => {
        keyring!.child.stdin!.once("error", () => resolve(false))
        keyring!.child.stdin!.end(password, () => resolve(true))
      })
      if (!(await bounded(written, probeMs))) throw failure("UNLOCK_UNCONFIRMED")
    } finally {
      password.fill(0)
    }
    await wait(async (remaining) => {
      const owner = await call(
        "org.freedesktop.DBus.GetConnectionUnixProcessID",
        ["org.freedesktop.secrets"],
        remaining,
      )
      if (!owner) return false
      if (owner !== `(uint32 ${keyring!.child.pid},)`) throw failure("SERVICE_OWNER_MISMATCH")
      return (
        (await call(
          "org.freedesktop.DBus.Properties.Get",
          ["org.freedesktop.Secret.Collection", "Locked"],
          Math.min(probeMs, Math.max(1, deadline - Date.now())),
          true,
        )) === "(<false>,)"
      )
    }, deadline)
    if (bus.closed || keyring.closed) throw failure("STARTUP_FAILED")
    exposed = true
    return { environment, close }
  } catch (error) {
    // No app has received this session yet, so failed setup can stop only the
    // processes this helper spawned. Unconfirmed shutdown retains its directory.
    if (!exposed) await close({ applicationExited: true, descendantsExited: true })
    throw error instanceof Error && /^LINUX_SECRET_SERVICE_[A-Z_]+$/.test(error.message)
      ? error
      : failure("STARTUP_FAILED")
  }
}

function managed(child: ChildProcess) {
  let closed = false
  let failed = false
  const done = new Promise<void>((resolve) => {
    child.once("error", () => {
      failed = true
      // A later error can mean kill() failed. Only a failed spawn with no PID
      // establishes that no owned process needs a confirmed close event.
      if (child.pid === undefined) {
        closed = true
        resolve()
      }
    })
    child.once("close", () => {
      closed = true
      resolve()
    })
  })
  return {
    child,
    done,
    get closed() {
      return closed
    },
    get failed() {
      return failed
    },
    detach() {
      child.stdout?.destroy()
      child.stdin?.destroy()
      child.unref()
    },
  }
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
