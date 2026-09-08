import { describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  createExternalURLOpener,
  openExternalTarget,
  resolveExternalURL,
  resolveLocalFilePath,
  snapshotExternalLaunchEnvironment,
} from "./external-url"
import { physicalEnvironment } from "../../../physicalsystems/src/environment"

function fakeLauncher() {
  const child = new EventEmitter() as ChildProcess
  let unrefs = 0
  child.unref = () => {
    unrefs++
    return child
  }
  return { child, unrefs: () => unrefs }
}

describe("external URLs", () => {
  test("acknowledges browser handoff, rejects unsupported targets and handles failed or stalled launchers", async () => {
    const calls: string[] = []
    expect(
      await openExternalTarget("https://example.com/login", async (url) => {
        calls.push(url)
      }),
    ).toBe(true)
    expect(
      await openExternalTarget("file:///tmp/private", async (url) => {
        calls.push(url)
      }),
    ).toBe(false)
    expect(calls).toEqual(["https://example.com/login"])
    expect(
      await openExternalTarget("https://example.com", async () => {
        throw new Error("private auth URL")
      }),
    ).toBe(false)
    expect(await openExternalTarget("https://example.com", () => new Promise(() => {}), 5)).toBe(false)
    expect(resolveExternalURL(null as unknown as string)).toBeUndefined()
  })
  test("opens web URLs externally", () => {
    expect(resolveExternalURL("https://example.com/a?b=c")).toBe("https://example.com/a?b=c")
    expect(resolveExternalURL("http://example.com")).toBe("http://example.com/")
  })

  test("opens mail links externally", () => {
    expect(resolveExternalURL("mailto:hello@opencode.ai")).toBe("mailto:hello@opencode.ai")
  })

  test("rejects file URLs and unsupported protocols", () => {
    expect(resolveExternalURL("file:///tmp/index.html")).toBeUndefined()
    expect(resolveExternalURL("javascript:alert(1)")).toBeUndefined()
    expect(resolveExternalURL("data:text/html,hello")).toBeUndefined()
    expect(resolveExternalURL("not a url")).toBeUndefined()
  })

  test("resolves only local file URLs", () => {
    const path = resolve("example.html")
    expect(resolveLocalFilePath(pathToFileURL(path).href)).toBe(path)
    expect(resolveLocalFilePath("file://example.com/share/index.html")).toBeUndefined()
    expect(resolveLocalFilePath("https://example.com/index.html")).toBeUndefined()
  })
})

describe("OS browser environment", () => {
  test("keeps the original browser routing after actual app profile isolation, without credentials or hooks", async () => {
    const original: NodeJS.ProcessEnv = {
      HOME: "/os/user",
      PATH: "/os/bin:/usr/bin:/bin",
      BROWSER: "/os/browser",
      XDG_CONFIG_HOME: "/os/config",
      XDG_DATA_HOME: "/os/data",
      XDG_RUNTIME_DIR: "/os/runtime",
      XDG_CURRENT_DESKTOP: "X-Generic",
      DISPLAY: ":99",
      XAUTHORITY: "/os/xauth",
      LANG: "en_US.UTF-8",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/os/bus",
      TMPDIR: "/os/tmp",
      OPENAI_API_KEY: "private-provider-fixture",
      GITHUB_TOKEN: "private-ci-fixture",
      LD_PRELOAD: "/private/loader",
      NODE_OPTIONS: "--require=/private/hook",
      ELECTRON_RUN_AS_NODE: "1",
      OPENCODE_CONFIG_CONTENT: "private-config-fixture",
      PHYSICALSYSTEMS_DATA_DIR: "/app/profile",
      ARBITRARY: "not-allowed",
    }
    const snapshot = snapshotExternalLaunchEnvironment(original)
    const launcher = fakeLauncher()
    let calls = 0
    const open = createExternalURLOpener({
      platform: "linux",
      environment: snapshot,
      open: async () => {
        throw new Error("Linux must use the isolated OS launcher")
      },
      spawn: (command, args, options) => {
        calls++
        expect(command).toBe("/usr/bin/xdg-open")
        expect(args).toEqual(["https://example.com/login?literal=$(inert)&code=fixture"])
        expect(options).toEqual({
          env: {
            HOME: "/os/user",
            PATH: "/os/bin:/usr/bin:/bin",
            BROWSER: "/os/browser",
            XDG_CONFIG_HOME: "/os/config",
            XDG_DATA_HOME: "/os/data",
            XDG_RUNTIME_DIR: "/os/runtime",
            XDG_CURRENT_DESKTOP: "X-Generic",
            DISPLAY: ":99",
            XAUTHORITY: "/os/xauth",
            LANG: "en_US.UTF-8",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/os/bus",
            TMPDIR: "/os/tmp",
          },
          shell: false,
          stdio: "ignore",
          detached: true,
        })
        // A launcher cannot mutate the snapshot used by another handoff.
        options.env.XDG_CONFIG_HOME = "/changed-by-launcher"
        queueMicrotask(() => launcher.child.emit("exit", 0, null))
        return launcher.child
      },
    })
    Object.assign(original, physicalEnvironment(original, "/app/profile"))
    expect(original.XDG_CONFIG_HOME).toBe("/app/profile/config")
    expect(snapshot.XDG_CONFIG_HOME).toBe("/os/config")
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(await open("https://example.com/login?literal=$(inert)&code=fixture")).toBe(true)
    expect(snapshot.XDG_CONFIG_HOME).toBe("/os/config")
    expect(calls).toBe(1)
    expect(launcher.unrefs()).toBe(1)
  })

  test("only exact permitted environment keys are inherited and malformed values are discarded", () => {
    expect(
      snapshotExternalLaunchEnvironment({
        HOME: "/user",
        PATH: "/bad\0/path",
        LANG: "C.UTF-8",
        LC_ALL: "C",
        WAYLAND_DISPLAY: "wayland-0",
        XDG_DATA_DIRS: "/usr/share",
        XDG_TOKEN: "private",
        LC_PRIVATE_SECRET: "private",
        BASH_ENV: "/private/hook",
        ENV: "/private/hook",
        PYTHONPATH: "/private/python",
        GIO_EXTRA_MODULES: "/private/gio",
        DBUS_STARTER_ADDRESS: "private",
      }),
    ).toEqual({
      HOME: "/user",
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_DATA_DIRS: "/usr/share",
    })
  })

  test("Linux acknowledges only exit zero and releases the controller on errors, signals and a deadline", async () => {
    for (const outcome of ["success", "failure", "signal", "error", "timeout", "throw"] as const) {
      const launcher = fakeLauncher()
      let calls = 0
      const open = createExternalURLOpener({
        platform: "linux",
        environment: {},
        open: async () => {
          throw new Error("unexpected Electron opener")
        },
        spawn: () => {
          calls++
          if (outcome === "throw") throw new Error("private launcher failure")
          queueMicrotask(() => {
            if (outcome === "success") launcher.child.emit("exit", 0, null)
            if (outcome === "failure") launcher.child.emit("exit", 1, null)
            if (outcome === "signal") launcher.child.emit("exit", null, "SIGTERM")
            if (outcome === "error") launcher.child.emit("error", new Error("private auth URL"))
          })
          return launcher.child
        },
      })
      expect(await open("https://example.com", 10)).toBe(outcome === "success")
      expect(calls).toBe(1)
      expect(launcher.unrefs()).toBe(outcome === "throw" ? 0 : 1)
      if (outcome === "timeout") {
        // A late failure/success cannot revise a false acknowledgement or leave
        // an unhandled error. No kill method is supplied by this fake process.
        launcher.child.emit("error", new Error("private late failure"))
        launcher.child.emit("exit", 0, null)
        expect(launcher.unrefs()).toBe(1)
      }
    }
  })

  test("rejects unsafe targets before launching and preserves Electron handoff on Windows and macOS", async () => {
    const targets: string[] = []
    let launches = 0
    for (const platform of ["linux", "win32", "darwin"] as const) {
      const open = createExternalURLOpener({
        platform,
        environment: {},
        open: async (url) => {
          targets.push(url)
        },
        spawn: () => {
          launches++
          throw new Error("unexpected process")
        },
      })
      for (const value of ["file:///tmp/private", "javascript:alert(1)", "--help", "invalid"]) {
        expect(await open(value)).toBe(false)
      }
      for (const timeout of [0, -1, 5001, 1.5]) expect(await open("https://example.com", timeout)).toBe(false)
      if (platform !== "linux") expect(await open("https://example.com")).toBe(true)
    }
    expect(launches).toBe(0)
    expect(targets).toEqual(["https://example.com/", "https://example.com/"])
  })
})
