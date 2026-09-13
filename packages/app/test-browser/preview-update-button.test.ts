import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { UpdaterState } from "../src/updater"

test("actual update button downloads and hands installation to native control without opening a manual download", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "preview-update-button-render-"))
  const container = document.createElement("div")
  document.body.append(container)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  let dispose: (() => void) | undefined
  try {
    await build({
      configFile: false,
      root: resolve(import.meta.dir, ".."),
      logLevel: "error",
      plugins: [solid()],
      resolve: {
        alias: [
          {
            find: "@/utils/toast",
            replacement: resolve(import.meta.dir, "fixtures/preview-update-button/environment.ts"),
          },
          { find: "@", replacement: resolve(import.meta.dir, "../src") },
        ],
      },
      build: {
        target: "esnext",
        outDir: temporary,
        emptyOutDir: true,
        lib: {
          entry: resolve(import.meta.dir, "fixtures/preview-update-button/entry.tsx"),
          formats: ["es"],
          fileName: () => "fixture.mjs",
        },
      },
    })
    const { mount } = await import(pathToFileURL(join(temporary, "fixture.mjs")).href)
    for (const os of ["windows", "linux"]) {
      const version = "0.1.0-beta.8"
      const available: UpdaterState = { status: "available", mode: "preview", version }
      const downloads: { resolve(value: UpdaterState): void; reject(error: Error): void }[] = []
      const installations: { resolve(): void; reject(error: Error): void }[] = []
      const checks: { resolve(value: UpdaterState): void }[] = []
      const recoveries: { resolve(value: UpdaterState): void }[] = []
      const calls: string[] = []
      const opened: string[] = []
      const instance = mount(
        container,
        available,
        {
          check() {
            calls.push("check")
            instance.publish({ status: "checking", mode: "preview" })
            return new Promise<UpdaterState>((resolve) => checks.push({ resolve }))
          },
          download() {
            calls.push("download")
            instance.publish({ status: "downloading", mode: "preview", version, percent: 0 })
            return new Promise<UpdaterState>((resolve, reject) => downloads.push({ resolve, reject }))
          },
          install() {
            calls.push("native-install")
            instance.publish({ status: "installing", mode: "preview", version })
            return new Promise<void>((resolve, reject) => installations.push({ resolve, reject }))
          },
          recover() {
            calls.push("recover")
            instance.publish({ status: "checking", mode: "preview" })
            return new Promise<UpdaterState>((resolve) => recoveries.push({ resolve }))
          },
          async open(url: string) {
            opened.push(url)
            return true
          },
        },
        os,
      )
      dispose = instance.dispose
      const button = () => container.querySelector<HTMLButtonElement>('button[data-action="desktop-update"]')!
      await settle()
      expect(button().textContent).toBe("Update")
      expect(button().getAttribute("aria-label")).toBe("Update")
      expect(button().disabled).toBe(false)
      expect(button().className).toContain("app-region:no-drag")
      button().click()
      await settle()
      expect(calls).toEqual(["download"])
      expect(button().textContent).toBe("Downloading...")
      expect(button().disabled).toBe(true)
      expect(button().getAttribute("aria-busy")).toBe("true")
      instance.publish({ status: "downloading", mode: "preview", version, percent: 55 })
      button().click()
      await settle()
      expect(calls).toEqual(["download"])
      downloads.shift()!.resolve({ status: "ready", mode: "preview", version })
      await settle()
      expect(calls).toEqual(["download", "native-install"])
      expect(button().textContent).toBe("Installing...")
      expect(button().disabled).toBe(true)

      // The native confirmation was declined. Reusing the already-verified
      // download requests native confirmation again, without downloading again.
      instance.publish({ status: "ready", mode: "preview", version })
      installations.shift()!.resolve()
      await settle()
      expect(button().disabled).toBe(false)
      expect(button().textContent).toBe("Install and restart")
      button().click()
      await settle()
      expect(calls).toEqual(["download", "native-install", "native-install"])
      instance.publish({
        status: "blocked",
        mode: "preview",
        version,
        message: "The native installation outcome needs confirmation.",
      })
      installations.shift()!.reject(new Error("inert-native-uncertainty"))
      await settle()
      expect(button().textContent).toBe("Update needs attention")
      expect(button().disabled).toBe(true)
      expect(button().title).toBe("The native installation outcome needs confirmation.")
      button().click()
      await settle()
      expect(calls).toEqual(["download", "native-install", "native-install"])
      expect(JSON.stringify(instance.fixture.toasts)).not.toContain("inert-native-uncertainty")

      // Only explicit recoverable native state enables inspection. Inspecting
      // an uncertain outcome must never download or launch another installer.
      instance.publish({
        status: "blocked",
        mode: "preview",
        version,
        recoverable: true,
        message: "Check the installed version before continuing.",
      })
      await settle()
      expect(button().textContent).toBe("Check installation")
      expect(button().disabled).toBe(false)
      button().click()
      await settle()
      expect(calls).toEqual(["download", "native-install", "native-install", "recover"])
      expect(button().disabled).toBe(true)
      button().click()
      await settle()
      expect(recoveries).toHaveLength(1)
      recoveries
        .shift()!
        .resolve({ status: "blocked", mode: "preview", version, message: "Installation is still uncertain." })
      await settle()
      expect(button().textContent).toBe("Update needs attention")
      expect(button().disabled).toBe(true)
      expect(calls).toEqual(["download", "native-install", "native-install", "recover"])
      expect(opened).toEqual([])

      // A failed download must not advance to native installation.
      instance.publish(available)
      await settle()
      button().click()
      await settle()
      downloads.shift()!.resolve({ status: "error", mode: "preview", message: "Download could not be verified." })
      await settle()
      expect(calls.filter((value) => value === "native-install")).toHaveLength(2)
      expect(button().textContent).toBe("Check now")
      expect(button().disabled).toBe(false)
      button().click()
      await settle()
      expect(button().disabled).toBe(true)
      expect(calls.at(-1)).toBe("check")
      checks.shift()!.resolve({ status: "up-to-date", mode: "preview" })
      await settle()
      expect(button().disabled).toBe(false)

      // The established signed workflow still keeps download and install
      // separate. Only the explicit preview mode chains the two actions.
      instance.publish({ status: "available", version })
      await settle()
      button().click()
      await settle()
      downloads.shift()!.resolve({ status: "ready", version })
      await settle()
      expect(calls.filter((value) => value === "native-install")).toHaveLength(2)
      expect(opened).toEqual([])
      expect(container.querySelector("a")).toBeNull()
      instance.publish({ status: "disabled" })
      await settle()
      expect(button()).toBeNull()
      instance.dispose()
      dispose = undefined
    }
  } finally {
    dispose?.()
    container.remove()
    await rm(temporary, { recursive: true, force: true })
  }
}, 30000)
