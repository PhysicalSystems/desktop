import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { launchUpdaterInstaller } from "./updater-install"
import { createUpdaterController } from "./updater-controller"
import { createShutdownCoordinator } from "../../../physicalsystems/src/lifecycle"

test("surfaces the library's emitted failure and resets quitting bookkeeping", () => {
  const emitter = new EventEmitter()
  const quitting: boolean[] = []
  const installer = Object.assign(emitter, {
    quitAndInstall() {
      emitter.emit("error", new Error("No update filepath provided"))
    },
  })
  expect(() => launchUpdaterInstaller(installer, (value) => quitting.push(value))).toThrow("No update filepath")
  expect(quitting).toEqual([true, false])
  expect(emitter.listenerCount("error")).toBe(0)
})

test("thrown failures also remove the temporary listener and reset quitting", () => {
  const installer = Object.assign(new EventEmitter(), {
    quitAndInstall() {
      throw new Error("Launch refused")
    },
  })
  const quitting: boolean[] = []
  expect(() => launchUpdaterInstaller(installer, (value) => quitting.push(value))).toThrow("Launch refused")
  expect(quitting).toEqual([true, false])
  expect(installer.listenerCount("error")).toBe(0)
})

test("successful scheduling preserves quitting state without claiming installer completion", () => {
  const installer = Object.assign(new EventEmitter(), { quitAndInstall() {} })
  const quitting: boolean[] = []
  launchUpdaterInstaller(installer, (value) => quitting.push(value))
  expect(quitting).toEqual([true])
  expect(installer.listenerCount("error")).toBe(0)
})

test("emitted install failure restores retryable controller state", async () => {
  const installer = Object.assign(new EventEmitter(), {
    quitAndInstall() {
      installer.emit("error", new Error("No cached installer"))
    },
  })
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: "1.0.0",
    backend: {
      checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
      downloadUpdate: async () => {},
      quitAndInstall: () => launchUpdaterInstaller(installer, () => {}),
    },
    persistence: { get: () => undefined, set() {}, clear() {} },
    confirmInstall: async () => true,
    install: async (launch) => launch(),
  })
  await controller.start()
  await controller.download()
  await expect(controller.install()).rejects.toThrow("No cached installer")
  expect(controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
})

test("real controller and shutdown coordinator reserve cleanup through installer handoff", async () => {
  for (const intent of ["quit", "relaunch"] as const) {
    const calls: string[] = []
    const started = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    const shutdown = createShutdownCoordinator({
      closeOperator: async () => {
        calls.push("operator")
      },
      stopServers: async () => {
        calls.push("model")
        started.resolve()
        await stopped.promise
      },
      finish: (intent) => {
        calls.push(intent)
      },
      blocked: (error) => {
        throw error
      },
    })
    const controller = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
        downloadUpdate: async () => {},
        quitAndInstall: () => {
          calls.push("installer")
        },
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      confirmInstall: async () => true,
      install: async (launch) => {
        if (!(await shutdown.update(launch))) throw new Error("UPDATE_SHUTDOWN_UNCONFIRMED")
      },
    })
    await controller.start()
    await controller.download()
    const installing = controller.install()
    await started.promise
    expect(await shutdown.request(intent)).toBe(false)
    expect(calls).toEqual(["operator", "model"])
    stopped.resolve()
    await installing
    expect(calls).toEqual(["operator", "model", "installer"])
    expect(await shutdown.request("relaunch")).toBe(false)
    expect(await shutdown.request("quit")).toBe(true)
    expect(calls).toEqual(["operator", "model", "installer", "quit"])
  }
})
