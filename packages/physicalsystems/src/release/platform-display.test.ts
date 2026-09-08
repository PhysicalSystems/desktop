// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { displayPixelEvidence, qualifyPlatformDisplay, requireDefaultDisplayArguments } from "./platform-display"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function pixels(ink = 0) {
  const data = new Uint8ClampedArray(240 * 32 * 4).fill(255)
  for (let pixel = 0; pixel < ink; pixel++) for (let channel = 0; channel < 3; channel++) data[pixel * 4 + channel] = 30
  return { width: 240, height: 32, pixels: data }
}

test("paint evidence rejects uniform frames, an unchanged image, one caret, transparency and size drift", () => {
  expect(displayPixelEvidence(pixels(), pixels(250))).toEqual({
    width: 240,
    height: 32,
    changedPixels: 250,
    contrastingPixels: 250,
  })
  for (const after of [pixels(), pixels(32), { ...pixels(250), width: 241 }])
    expect(() => displayPixelEvidence(pixels(), after)).toThrow("PLATFORM_DISPLAY_PAINT_UNCONFIRMED")
  expect(() => displayPixelEvidence(pixels(250), pixels(250))).toThrow("PLATFORM_DISPLAY_PAINT_UNCONFIRMED")
  const transparent = pixels(250)
  transparent.pixels[3] = 0
  expect(() => displayPixelEvidence(pixels(), transparent)).toThrow("PLATFORM_DISPLAY_PAINT_UNCONFIRMED")
  const black = pixels(240 * 32)
  expect(() => displayPixelEvidence(pixels(), black)).toThrow("PLATFORM_DISPLAY_PAINT_UNCONFIRMED")
})

test("normal graphics qualification rejects forced GPU/compositor backends and sandbox bypasses", () => {
  requireDefaultDisplayArguments(["--remote-debugging-port=0", "--user-data-dir=/owned/profile"])
  for (const flag of [
    "--disable-gpu",
    "--disable-gpu=true",
    "--headless=new",
    "--ozone-platform=x11",
    "--use-gl=swiftshader",
    "--use-angle=swiftshader",
    "--disable-gpu-sandbox",
    "--no-sandbox",
    "--disable-seccomp-filter-sandbox",
  ])
    expect(() => requireDefaultDisplayArguments([flag])).toThrow("PLATFORM_DISPLAY_NONDEFAULT_ARGUMENTS")
  requireDefaultDisplayArguments(["--user-data-dir=/owned/--disable-gpu"])
})

async function fixture(
  variation: { blank?: boolean; badRestore?: boolean; failZoom?: boolean; preexistingDraft?: boolean } = {},
) {
  // All protocol calls are in-memory fakes. There is no Electron, display
  // server, screenshot, native window, keyring or model connection in this test.
  const temporary = await mkdtemp(join(tmpdir(), "display-fixture-"))
  roots.push(temporary)
  const root = join(temporary, "owned")
  await mkdir(root)
  const original = { left: 1, top: 2, width: 1280, height: 800, windowState: "normal" }
  const bounds = { ...original }
  let zoom = 1
  let text = variation.preexistingDraft ? "user's draft" : ""
  let focused = true
  let composerFocused = false
  let selected = false
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const state = () => ({
    visible: true,
    focused,
    composerFocused,
    editable: true,
    text,
    width: Math.floor(bounds.width / zoom),
    height: Math.floor((bounds.height - 40) / zoom),
    outerWidth: bounds.width,
    outerHeight: bounds.height,
    screenX: bounds.left,
    screenY: bounds.top,
    rect: {
      x: 300,
      y: Math.floor((bounds.height - 160) / zoom),
      width: Math.min(700, bounds.width / zoom - 350),
      height: 48,
    },
  })
  const input = {
    root,
    targetId: "owned-fixture-page",
    launchArguments: ["--remote-debugging-port=0"],
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
      GITHUB_RUN_ID: "12345",
      RUNNER_TEMP: temporary,
      DISPLAY: ":99",
    },
    async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
      calls.push({ method, params })
      if (method === "Runtime.evaluate") return { result: { objectId: "original-focused-element" } }
      if (method === "Runtime.callFunctionOn") {
        composerFocused = false
        return { result: { value: true } }
      }
      if (method === "Page.bringToFront") focused = true
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") composerFocused = true
      if (method === "Input.insertText") text = String(params?.text)
      if (method === "Input.dispatchKeyEvent" && params?.type === "keyDown") {
        if (params.key === "a" && params.modifiers === 2) selected = true
        if (params.key === "Backspace" && selected) {
          text = ""
          selected = false
        }
      }
      if (method === "Page.captureScreenshot")
        return { data: Buffer.from(text ? "FAKE-TYPED-PIXELS" : "FAKE-EMPTY-PIXELS").toString("base64") }
      return {}
    },
    async evaluate(expression: string): Promise<unknown> {
      calls.push({ method: "evaluate", params: { expression } })
      if (expression.includes("getWindowFocused")) return { focused, fullscreen: false, zoom }
      if (expression.startsWith("window.api.setZoomFactor(")) {
        const next = Number(expression.slice("window.api.setZoomFactor(".length, -1))
        if (variation.failZoom && next !== 1) throw new Error("PRIVATE_PROTOCOL_TRAP")
        if (!(variation.badRestore && next === 1)) zoom = next
        return undefined
      }
      if (expression.includes("OffscreenCanvas"))
        return displayPixelEvidence(pixels(), pixels(variation.blank ? 0 : 250))
      if (expression.includes("platformDisplayState")) return state()
      if (expression.includes("?.focus()")) {
        composerFocused = true
        return undefined
      }
      throw new Error("Unexpected fake evaluation")
    },
  }
  return { input, calls, state, bounds: () => bounds, original, zoom: () => zoom }
}

test("fake orchestration exercises real-control protocol paths then restores draft, focus and native zoom", async () => {
  const f = await fixture()
  const result = await qualifyPlatformDisplay(f.input, "linux")
  expect(result).toEqual({
    scope: "linux-x11-xvfb",
    defaultGraphicsArguments: true,
    nativeWindowVisible: true,
    composerPointerFocus: true,
    keyboardEditing: true,
    compositorPaint: true,
    nativeWindowFocused: true,
    zoomRepaint: true,
    restoredDraftFocusAndZoom: true,
    arbitraryNativeResizeTested: false,
    pixels: { width: 240, height: 32, changedPixels: 250, contrastingPixels: 250 },
    gpuHardwareVerified: false,
    waylandTested: false,
    physicalDisplayMeasured: false,
    opticalFlickerMeasured: false,
  })
  expect(f.state().text).toBe("")
  expect(f.state().composerFocused).toBe(false)
  expect(f.bounds()).toEqual(f.original)
  expect(f.calls.filter((call) => call.method === "Page.captureScreenshot")).toHaveLength(4)
  expect(f.calls.filter((call) => call.method === "Input.insertText")).toHaveLength(2)
  expect(f.calls.some((call) => call.params?.key === "Enter")).toBe(false)
  expect(f.zoom()).toBe(1)
  expect(f.calls.some((call) => call.method.startsWith("Browser."))).toBe(false)
  expect(f.calls.at(-1)?.method).toBe("Runtime.releaseObject")
  expect(JSON.stringify(result)).not.toContain("FAKE-")
  expect(JSON.stringify(result)).not.toContain("PASS")
})

test("blank rendering and protocol failure remain failures even after successful state restoration", async () => {
  for (const variation of [{ blank: true }, { failZoom: true }]) {
    const f = await fixture(variation)
    await expect(qualifyPlatformDisplay(f.input, "linux")).rejects.toThrow(
      /PLATFORM_DISPLAY_(?:PAINT|PROBE)_UNCONFIRMED/,
    )
    expect(f.state().text).toBe("")
    expect(f.bounds()).toEqual(f.original)
    expect(f.state().composerFocused).toBe(false)
  }
})

test("an unconfirmed restoration cannot produce successful display evidence", async () => {
  const f = await fixture({ badRestore: true })
  await expect(qualifyPlatformDisplay(f.input, "linux")).rejects.toThrow("PLATFORM_DISPLAY_RESTORE_UNCONFIRMED")
  expect(
    f.calls.filter((call) => String(call.params?.expression).startsWith("window.api.setZoomFactor(")),
  ).toHaveLength(2)
})

test("local runners, Wayland, headless arguments and an existing draft refuse input mutation", async () => {
  for (const kind of ["local", "wayland", "headless", "draft"]) {
    const f = await fixture({ preexistingDraft: kind === "draft" })
    if (kind === "local") f.input.env.CI = "false"
    if (kind === "wayland") Object.assign(f.input.env, { WAYLAND_DISPLAY: "wayland-0" })
    if (kind === "headless") f.input.launchArguments.push("--headless")
    await expect(qualifyPlatformDisplay(f.input, "linux")).rejects.toThrow()
    expect(
      f.calls.some(
        (call) =>
          call.method.startsWith("Input.") || String(call.params?.expression).startsWith("window.api.setZoomFactor("),
      ),
    ).toBe(false)
  }
})
