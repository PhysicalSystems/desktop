import { describe, expect, test } from "bun:test"
import { createUpdaterController, type UpdaterBackend, type UpdaterReadyRecord } from "./updater-controller"

function setup(input?: {
  enabled?: boolean
  confirm?: boolean
  currentVersion?: string
  version?: string
  ready?: UpdaterReadyRecord
}) {
  const calls: string[] = []
  const backend: UpdaterBackend = {
    async checkForUpdates() {
      calls.push("check")
      return { isUpdateAvailable: true, updateInfo: { version: input?.version ?? "2.0.0" } }
    },
    async downloadUpdate() {
      calls.push("download")
    },
    quitAndInstall() {
      calls.push("install")
    },
  }
  let ready = input?.ready
  const controller = createUpdaterController({
    enabled: input?.enabled ?? true,
    currentVersion: input?.currentVersion ?? "1.0.0",
    backend,
    persistence: {
      get: () => ready,
      set: (value) => {
        ready = value
      },
      clear: () => {
        ready = undefined
      },
    },
    install: async (launch) => {
      calls.push("stop")
      launch()
    },
    confirmInstall: async () => {
      calls.push("confirm")
      return input?.confirm ?? true
    },
  })
  return { controller, calls, backend, getReady: () => ready }
}

describe("updater controller", () => {
  test("announces availability without downloading or restarting, then downloads only on request", async () => {
    const app = setup()
    const states: ReturnType<typeof app.controller.getState>[] = []
    app.controller.subscribe((state) => states.push(state))

    await app.controller.start()

    expect(app.calls).toEqual(["check"])
    expect(app.controller.getState()).toEqual({ status: "available", version: "2.0.0" })
    expect(app.getReady()).toBeUndefined()
    await expect(app.controller.install()).rejects.toThrow("not ready")
    await app.controller.download()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.getReady()).toEqual({ version: "2.0.0" })
    expect(states.map((state) => state.status)).toEqual(["idle", "checking", "available", "downloading", "ready"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("persisted target cannot grant install or automatic download authority on launch", async () => {
    const app = setup({ ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.calls).toEqual(["check"])
    expect(app.getReady()).toBeUndefined()
    expect(app.controller.getState()).toEqual({ status: "available", version: "2.0.0" })
  })

  test("clears a target already installed before checking", async () => {
    const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.getReady()).toBeUndefined()
    expect(app.calls).toEqual(["check"])
  })

  test("coalesces concurrent checks", async () => {
    const app = setup()

    await Promise.all([app.controller.check(), app.controller.check(), app.controller.check()])

    expect(app.calls).toEqual(["check"])
  })

  test("remains installing while Electron schedules exit and rejects duplicate installs", async () => {
    const app = setup()
    await app.controller.start()
    await app.controller.download()

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "confirm", "stop", "install"])
    expect(app.controller.getState()).toEqual({ status: "installing", version: "2.0.0" })
    await app.controller.check()
    await app.controller.download()
    await expect(app.controller.install()).rejects.toThrow("not ready")
    expect(app.calls).toHaveLength(5)
  })

  test("returns to ready when installation cannot start", async () => {
    const app = setup()
    await app.controller.start()

    const failed = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
        downloadUpdate: async () => {},
        quitAndInstall() {
          throw new Error("must not install before cleanup")
        },
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      install: async () => {
        throw new Error("stop failed")
      },
      confirmInstall: async () => true,
    })
    await failed.start()
    await failed.download()

    await expect(failed.install()).rejects.toThrow("stop failed")
    expect(failed.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("disabled builds do not check, download, prompt, stop or alter persisted data", async () => {
    const app = setup({ enabled: false, ready: { version: "2.0.0" } })
    await app.controller.start()
    await app.controller.check()
    await app.controller.download()
    await expect(app.controller.install()).rejects.toThrow("not ready")
    expect(app.controller.getState()).toEqual({ status: "disabled" })
    expect(app.getReady()).toEqual({ version: "2.0.0" })
    expect(app.calls).toEqual([])
  })

  for (const [currentVersion, version, status] of [
    ["2.0.0", "2.0.0", "up-to-date"],
    ["2.0.0", "1.9.0", "up-to-date"],
    ["1.9.0", "1.10.0", "available"],
    ["0.1.0-beta.2", "0.1.0-beta.10", "available"],
    ["0.1.0", "0.1.0-beta.10", "up-to-date"],
    ["0.1.0-beta.10", "0.1.0", "available"],
    ["1.0.0", "desktop-v2.0.0", "error"],
    ["1.0.0", "9007199254740992.0.0", "error"],
  ]) {
    test(`compares Desktop versions ${currentVersion} -> ${version}`, async () => {
      const app = setup({ currentVersion, version })
      await app.controller.start()
      expect(app.controller.getState().status).toBe(status)
      expect(app.calls).toEqual(["check"])
    })
  }

  test("coalesces downloading with concurrent checks and never exposes an unverified ready state", async () => {
    const app = setup()
    const work = Promise.withResolvers<void>()
    app.backend.downloadUpdate = async (progress) => {
      app.calls.push("download")
      progress(37)
      await work.promise
    }
    await app.controller.start()
    const download = app.controller.download()
    expect(app.controller.download()).toBe(download)
    expect(app.controller.check()).toBe(download)
    await Promise.resolve()
    expect(app.controller.getState()).toEqual({ status: "downloading", version: "2.0.0", percent: 37 })
    expect(app.getReady()).toBeUndefined()
    await expect(app.controller.install()).rejects.toThrow("not ready")
    work.resolve()
    await download
    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState().status).toBe("ready")
  })

  test("failed backend verification never becomes ready, but explicit retry is possible", async () => {
    const app = setup()
    await app.controller.start()
    app.backend.downloadUpdate = async () => {
      throw new Error("Publisher mismatch")
    }
    await app.controller.download()
    expect(app.controller.getState()).toEqual({ status: "error", message: "Publisher mismatch" })
    expect(app.getReady()).toBeUndefined()
    await expect(app.controller.install()).rejects.toThrow("not ready")
    await app.controller.check()
    app.backend.downloadUpdate = async () => {}
    await app.controller.download()
    expect(app.controller.getState().status).toBe("ready")
    expect(app.calls).toEqual(["check", "check"])
  })

  test("offline checks are visible and retryable", async () => {
    const app = setup()
    app.backend.checkForUpdates = async () => {
      throw new Error("Offline")
    }
    await app.controller.check()
    expect(app.controller.getState()).toEqual({ status: "error", message: "Offline" })
    app.backend.checkForUpdates = async () => ({ isUpdateAvailable: false })
    expect(await app.controller.check()).toEqual({ status: "up-to-date" })
  })

  test("clamps progress and ignores non-finite values", async () => {
    const app = setup()
    const percentages: (number | undefined)[] = []
    app.controller.subscribe((state) => {
      if (state.status === "downloading") percentages.push(state.percent)
    })
    app.backend.downloadUpdate = async (progress) => {
      ;[-3, 37, NaN, Infinity, 111].forEach(progress)
    }
    await app.controller.start()
    await app.controller.download()
    expect(percentages).toEqual([undefined, 0, 37, 100])
  })

  test("cancelling restart keeps the verified update ready and services untouched", async () => {
    const app = setup({ confirm: false })
    await app.controller.start()
    await app.controller.download()
    await app.controller.install()
    expect(app.calls).toEqual(["check", "download", "confirm"])
    expect(app.controller.getState().status).toBe("ready")
  })
})
