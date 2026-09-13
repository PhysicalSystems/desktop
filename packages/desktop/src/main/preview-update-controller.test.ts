import { expect, test } from "bun:test"
import { createPreviewUpdateController, type PreviewUpdateAttempt } from "./preview-update-controller"
import type { DesktopUpdateDiscoveryResult } from "./desktop-update-discovery"
import { createShutdownCoordinator } from "../../../physicalsystems/src/lifecycle"
const release = {
  status: "available",
  version: "0.1.0-beta.9",
  channel: "preview",
  unsignedWindowsPreview: true,
  downloadUrl: "https://physicalsystems.ai/download",
  releaseNotesUrl: "https://github.com/PhysicalSystems/physicalsystems/releases/tag/desktop-v0.1.0-beta.9",
  assets: ["windows-x64.exe", "linux-x64.deb", "linux-x64.AppImage"].map((suffix) => ({
    name: `physical-systems-desktop-0.1.0-beta.9-${suffix}`,
    bytes: 20,
    sha256: "a".repeat(64),
    url: `https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0-beta.9/physical-systems-desktop-0.1.0-beta.9-${suffix}`,
  })),
} satisfies DesktopUpdateDiscoveryResult
function fixture(platform: "win32" | "linux" = "linux") {
  const calls: string[] = []
  const state = {
    confirm: true,
    supported: true,
    tampered: false,
    uncertain: false,
    cleanupFails: false,
    recovery: "uncertain" as "installed" | "not-installed" | "uncertain",
    journal: undefined as PreviewUpdateAttempt | undefined,
    discovery: structuredClone(release) as DesktopUpdateDiscoveryResult,
    install: async () => {},
  }
  const shutdown = createShutdownCoordinator({
    async closeOperator() {
      calls.push("operator")
      if (state.cleanupFails) throw new Error("busy")
    },
    async stopServers() {
      calls.push("servers")
    },
    finish() {},
    blocked() {},
    updateUncertain(error) {
      return error instanceof Error && error.message === "uncertain"
    },
  })
  const input = {
    enabled: true,
    platform,
    currentVersion: "0.1.0-beta.8",
    async supported() {
      calls.push("support")
      return state.supported
    },
    async discover() {
      calls.push("discover")
      return state.discovery
    },
    async download(asset: (typeof release.assets)[number], progress: (percent: number) => void) {
      calls.push(asset.name.endsWith(".exe") ? "download-exe" : "download-deb")
      progress(50)
      return "/private/installer"
    },
    async verify() {
      calls.push("verify")
      if (state.tampered) throw new Error("hash")
    },
    async confirm() {
      calls.push("confirm")
      return state.confirm
    },
    async shutdown(launch: () => Promise<void>) {
      if (!(await shutdown.update(launch))) throw new Error("shutdown")
    },
    async install() {
      calls.push("install")
      await state.install()
      if (state.uncertain) throw new Error("uncertain")
    },
    finish() {
      calls.push("finish")
    },
    async recover() {
      calls.push("recover")
      return { status: state.recovery }
    },
    resume() {
      calls.push("resume")
      if (!shutdown.clearUpdateUncertainty()) throw new Error("active")
    },
    journal: {
      get() {
        return state.journal
      },
      set(value: PreviewUpdateAttempt) {
        calls.push("journal")
        state.journal = value
      },
      clear() {
        calls.push("clear")
        state.journal = undefined
      },
    },
    message(code: string) {
      return code
    },
    uncertain(error: unknown) {
      return error instanceof Error && error.message === "uncertain"
    },
  }
  return { calls, state, input, controller: createPreviewUpdateController(input), shutdown }
}
for (const platform of ["win32", "linux"] as const) {
  test(`${platform}: explicit verified download, confirmation, rehash and owned shutdown precede installation`, async () => {
    const f = fixture(platform)
    await f.controller.start()
    expect(f.calls).toEqual(["support", "discover"])
    await f.controller.download()
    expect(f.controller.getState().status).toBe("ready")
    expect(f.calls).not.toContain("install")
    await f.controller.install()
    expect(f.calls.slice(-9)).toEqual([
      "discover",
      "verify",
      "support",
      "operator",
      "servers",
      "verify",
      "journal",
      "install",
      "finish",
    ])
    expect(f.state.journal?.to).toBe(release.version)
  })
  test(`${platform}: cancel leaves services running and no attempt journal`, async () => {
    const f = fixture(platform)
    await f.controller.start()
    await f.controller.download()
    f.state.confirm = false
    await f.controller.install()
    expect(f.controller.getState().status).toBe("ready")
    expect(f.state.journal).toBeUndefined()
    expect(f.calls).not.toContain("operator")
  })
  test(`${platform}: replaced release or tampered bytes never reach shutdown`, async () => {
    for (const change of ["release", "file"]) {
      const f = fixture(platform)
      await f.controller.start()
      await f.controller.download()
      if (change === "release") f.state.discovery = { status: "up-to-date", version: "0.1.0-beta.8" }
      else f.state.tampered = true
      await expect(f.controller.install()).rejects.toThrow()
      expect(f.calls).not.toContain("operator")
      expect(f.calls).not.toContain("install")
    }
  })
  test(`${platform}: uncertain native outcome blocks retry and never reports installation success`, async () => {
    const f = fixture(platform)
    await f.controller.start()
    await f.controller.download()
    f.state.uncertain = true
    await expect(f.controller.install()).rejects.toThrow("uncertain")
    expect(f.controller.getState().status).toBe("blocked")
    expect(f.state.journal?.to).toBe(release.version)
    const count = f.calls.length
    await f.controller.check()
    await f.controller.download()
    await expect(f.controller.install()).rejects.toThrow()
    expect(f.calls.length).toBe(count)
    expect(f.calls).not.toContain("finish")
  })
}
test("failed operator cleanup prevents installation or quit", async () => {
  const f = fixture()
  await f.controller.start()
  await f.controller.download()
  f.state.cleanupFails = true
  await expect(f.controller.install()).rejects.toThrow()
  expect(f.calls).not.toContain("install")
  expect(f.calls).not.toContain("finish")
  expect(f.state.journal).toBeUndefined()
})
test("disabled performs no IO; unsupported package performs no discovery", async () => {
  const f = fixture()
  const disabled = createPreviewUpdateController({ ...f.input, enabled: false })
  await disabled.start()
  await disabled.check()
  await disabled.download()
  expect(f.calls).toEqual([])
  f.state.supported = false
  await f.controller.start()
  expect(f.controller.getState().status).toBe("disabled")
  expect(f.calls).toEqual(["support"])
})
test("signed and stable targets do not bypass their existing qualification policy", async () => {
  for (const patch of [{ channel: "stable" as const }, { unsignedWindowsPreview: false }]) {
    const f = fixture()
    f.state.discovery = { ...release, ...patch }
    await f.controller.start()
    await f.controller.download()
    expect(f.controller.getState().status).toBe("error")
    expect(f.calls).not.toContain("download-deb")
  }
})
test("new startup acknowledges actual version; an old startup cannot replay a pending installation", async () => {
  const f = fixture()
  f.state.journal = { from: "0.1.0-beta.8", to: release.version, sha256: "a".repeat(64) }
  await f.controller.start()
  expect(f.controller.getState().status).toBe("blocked")
  expect(f.calls).toEqual([])
  const updated = createPreviewUpdateController({ ...f.input, currentVersion: release.version })
  await updated.start()
  expect(f.state.journal).toBeUndefined()
  expect(f.calls.slice(0, 2)).toEqual(["support", "clear"])
  expect(f.calls).not.toContain("install")
})
test("parallel clicks share one installer and asynchronous handoff blocks competing relaunch/quit", async () => {
  const f = fixture()
  let acknowledge!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.state.install = () => {
    entered()
    return new Promise<void>((resolve) => {
      acknowledge = resolve
    })
  }
  await f.controller.start()
  await f.controller.download()
  const first = f.controller.install()
  const second = f.controller.install()
  expect(first).toBe(second)
  await enteredPromise
  expect(await f.shutdown.request("relaunch")).toBe(false)
  expect(await f.shutdown.request("quit")).toBe(false)
  expect(f.calls).not.toContain("finish")
  acknowledge()
  await first
  expect(f.calls.filter((x) => x === "install")).toHaveLength(1)
  expect(f.calls.at(-1)).toBe("finish")
})

test("an invalid persisted attempt blocks all checks, and unsupported installation cannot acknowledge a target version", async () => {
  const f = fixture()
  const corrupted = createPreviewUpdateController({
    ...f.input,
    journal: {
      ...f.input.journal,
      get() {
        throw new Error("invalid")
      },
    },
  })
  await corrupted.check()
  await corrupted.start()
  await corrupted.check()
  expect(corrupted.getState().status).toBe("blocked")
  expect(f.calls).toEqual([])
  f.state.journal = { from: "0.1.0-beta.8", to: release.version, sha256: "a".repeat(64) }
  f.state.supported = false
  const copied = createPreviewUpdateController({ ...f.input, currentVersion: release.version })
  await copied.start()
  expect(copied.getState().status).toBe("blocked")
  expect(f.state.journal).toBeDefined()
})

test("uncertain installation keeps lifecycle blocked until an explicit native cancellation proof", async () => {
  const f = fixture()
  await f.controller.start()
  await f.controller.download()
  f.state.uncertain = true
  await expect(f.controller.install()).rejects.toThrow()
  expect(await f.shutdown.request("relaunch")).toBe(false)
  expect(await f.shutdown.request("quit")).toBe(false)
  await f.controller.check()
  expect(f.calls).not.toContain("recover")
  await f.controller.recover()
  expect(f.controller.getState().status).toBe("blocked")
  expect(f.calls).not.toContain("resume")
  expect(f.state.journal).toBeDefined()
  f.state.recovery = "not-installed"
  await f.controller.recover()
  expect(f.controller.getState().status).toBe("available")
  expect(f.state.journal).toBeUndefined()
  expect(f.calls.filter((x) => x === "install")).toHaveLength(1)
  expect(await f.shutdown.request("relaunch")).toBe(true)
})

test("recovering a completed installation cleans up before relaunch and retains the journal for new startup", async () => {
  const f = fixture()
  f.state.journal = { from: f.input.currentVersion, to: release.version, sha256: "a".repeat(64) }
  f.state.recovery = "installed"
  await f.controller.start()
  await f.controller.recover()
  expect(f.calls).toEqual(["recover", "resume", "operator", "servers", "finish"])
  expect(f.controller.getState().status).toBe("installing")
  expect(f.state.journal?.to).toBe(release.version)
  expect(await f.shutdown.request("relaunch")).toBe(false)
})

test("completed recovery cannot bypass failed operator cleanup or install again", async () => {
  const f = fixture()
  f.state.journal = { from: f.input.currentVersion, to: release.version, sha256: "a".repeat(64) }
  f.state.recovery = "installed"
  f.state.cleanupFails = true
  await f.controller.start()
  await f.controller.recover()
  expect(f.controller.getState().status).toBe("blocked")
  expect(f.state.journal).toBeDefined()
  expect(f.calls).not.toContain("finish")
  expect(f.calls).not.toContain("install")
})

test("recovery clicks coalesce; periodic checks cannot clear the attempt during native observation", async () => {
  const f = fixture()
  f.state.journal = { from: f.input.currentVersion, to: release.version, sha256: "a".repeat(64) }
  let releaseObservation!: (value: { status: "not-installed" }) => void
  const controller = createPreviewUpdateController({
    ...f.input,
    recover: () => {
      f.calls.push("recover")
      return new Promise((resolve) => {
        releaseObservation = resolve
      })
    },
  })
  await controller.start()
  const first = controller.recover()
  const second = controller.recover()
  const periodic = controller.check()
  expect(f.calls).toEqual(["recover"])
  expect(f.state.journal).toBeDefined()
  releaseObservation({ status: "not-installed" })
  await Promise.all([first, second, periodic])
  expect(f.calls.filter((x) => x === "recover")).toHaveLength(1)
  expect(f.calls.filter((x) => x === "clear")).toHaveLength(1)
  expect(f.calls.filter((x) => x === "discover")).toHaveLength(1)
})

test("an actually running newer supported version acknowledges an older pending target", async () => {
  const f = fixture()
  f.state.journal = { from: f.input.currentVersion, to: release.version, sha256: "a".repeat(64) }
  const newer = createPreviewUpdateController({ ...f.input, currentVersion: "0.1.0-beta.10" })
  await newer.start()
  expect(f.state.journal).toBeUndefined()
  expect(f.calls).not.toContain("recover")
  expect(f.calls).not.toContain("install")
})
