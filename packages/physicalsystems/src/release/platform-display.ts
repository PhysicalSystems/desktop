// SPDX-License-Identifier: Apache-2.0
import { requireDisposablePublicRunner } from "./public-qualification"

const marker = "Display input verification 0123456789"
const selector = "[data-component=prompt-input][contenteditable=true]"
type State = {
  visible: boolean
  focused: boolean
  composerFocused: boolean
  pointerHitsComposer: boolean
  editable: boolean
  text: string
  width: number
  height: number
  outerWidth: number
  outerHeight: number
  screenX: number
  screenY: number
  scrollX: number
  scrollY: number
  rect: { x: number; y: number; width: number; height: number }
}

/** Used on real compositor captures in the renderer; fixture pixels in unit tests
 * do not establish native display evidence. This function is self-contained. */
export function displayPixelEvidence(
  before: { width: number; height: number; pixels: ArrayLike<number> },
  after: { width: number; height: number; pixels: ArrayLike<number> },
) {
  const { width, height } = before
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 120 ||
    width > 1024 ||
    height < 16 ||
    height > 256 ||
    after.width !== width ||
    after.height !== height ||
    before.pixels.length !== width * height * 4 ||
    after.pixels.length !== width * height * 4
  )
    throw new Error("PLATFORM_DISPLAY_DIMENSIONS_UNCONFIRMED")
  let changedPixels = 0
  const colors = new Map<number, number>()
  for (let index = 0; index < after.pixels.length; index += 4) {
    if (before.pixels[index + 3] !== 255 || after.pixels[index + 3] !== 255)
      throw new Error("PLATFORM_DISPLAY_PAINT_UNCONFIRMED")
    const rgb = [after.pixels[index], after.pixels[index + 1], after.pixels[index + 2]]
    if (
      rgb.some(
        (value, offset) =>
          !Number.isInteger(value) ||
          value < 0 ||
          value > 255 ||
          !Number.isInteger(before.pixels[index + offset]) ||
          before.pixels[index + offset] < 0 ||
          before.pixels[index + offset] > 255,
      )
    )
      throw new Error("PLATFORM_DISPLAY_PAINT_UNCONFIRMED")
    if (rgb.some((value, offset) => Math.abs(value - before.pixels[index + offset]) > 24)) changedPixels++
    // Quantization tolerates antialiasing while distinguishing actual glyphs
    // from a uniform compositor surface or one blinking caret.
    const color = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4)
    colors.set(color, (colors.get(color) ?? 0) + 1)
  }
  const contrastingPixels = width * height - Math.max(...colors.values())
  if (changedPixels < 120 || contrastingPixels < 120) throw new Error("PLATFORM_DISPLAY_PAINT_UNCONFIRMED")
  return { width, height, changedPixels, contrastingPixels }
}

/** Page.captureScreenshot accepts DIP, while DOM rectangles are CSS pixels.
 * Convert with the native zoom that the caller has independently observed. */
export function platformDisplayClip(value: State, zoom: number) {
  if (
    !Number.isFinite(zoom) ||
    zoom < 0.5 ||
    zoom > 3 ||
    [value.scrollX, value.scrollY, ...Object.values(value.rect)].some((value) => !Number.isFinite(value))
  )
    throw new Error("PLATFORM_DISPLAY_GEOMETRY_UNCONFIRMED")
  return {
    x: Math.ceil((value.rect.x + value.scrollX + 4) * zoom),
    y: Math.ceil((value.rect.y + value.scrollY + 4) * zoom),
    width: Math.floor(Math.min(540, (value.rect.width - 8) * zoom)),
    height: Math.floor(Math.min(64, (value.rect.height - 8) * zoom)),
    scale: 1,
  }
}

/** The same expression is executed by the owned renderer and by inert VM tests.
 * Fixed result codes survive the CDP exception sanitizer; pixels stay in memory. */
export function displayPixelsExpression(before: string, after: string) {
  return `(async () => {
    const decode = async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      try {
        if (image.width > 1024 || image.height > 256) throw new Error('PLATFORM_DISPLAY_DIMENSIONS_UNCONFIRMED');
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('PLATFORM_DISPLAY_DECODE_UNCONFIRMED');
        context.drawImage(image, 0, 0);
        return { width: image.width, height: image.height, pixels: context.getImageData(0, 0, image.width, image.height).data };
      } finally { image.close() }
    };
    try {
      return { observation: (${displayPixelEvidence.toString()})(await decode(${JSON.stringify(before)}), await decode(${JSON.stringify(after)})) };
    } catch (error) {
      const code = error?.message;
      return { error: ['PLATFORM_DISPLAY_PAINT_UNCONFIRMED', 'PLATFORM_DISPLAY_DIMENSIONS_UNCONFIRMED'].includes(code)
        ? code : 'PLATFORM_DISPLAY_DECODE_UNCONFIRMED' };
    }
  })()`
}

/** Genuine app composer only. No overlay, fake widget, camera or model request. */
export function platformDisplayState() {
  const elements = document.querySelectorAll<HTMLElement>("[data-component=prompt-input][contenteditable=true]")
  const element = elements.length === 1 ? elements[0] : undefined
  const rect = element?.getBoundingClientRect()
  const style = element && getComputedStyle(element)
  const hit = rect && document.elementFromPoint(rect.x + Math.min(rect.width / 2, 120), rect.y + rect.height / 2)
  return {
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
    composerFocused: document.activeElement === element,
    pointerHitsComposer: Boolean(element && hit && (hit === element || element.contains(hit))),
    editable: Boolean(
      element?.isContentEditable &&
        style?.visibility === "visible" &&
        style.display !== "none" &&
        Number(style.opacity) > 0,
    ),
    text: element?.textContent ?? "",
    width: innerWidth,
    height: innerHeight,
    outerWidth,
    outerHeight,
    screenX,
    screenY,
    scrollX,
    scrollY,
    rect: { x: rect?.x ?? -1, y: rect?.y ?? -1, width: rect?.width ?? 0, height: rect?.height ?? 0 },
  }
}

export function requireDefaultDisplayArguments(args: string[]) {
  if (
    !Array.isArray(args) ||
    args.some(
      (argument) =>
        typeof argument !== "string" ||
        /^--?(?:headless|disable-gpu(?:-compositing|-sandbox)?|disable-software-rasterizer|use-gl|use-angle|ozone-platform|enable-unsafe-swiftshader|no-sandbox|disable-(?:setuid|namespace|seccomp-filter)-sandbox)(?:=|$)/.test(
          argument,
        ),
    )
  )
    throw new Error("PLATFORM_DISPLAY_NONDEFAULT_ARGUMENTS")
}

/** The caller supplies the verified owned page and the actual arguments used to
 * start it. CDP calls are serialized, bounded and never retried when mutating. */
export async function qualifyPlatformDisplay(
  input: {
    env: NodeJS.ProcessEnv
    root: string
    targetId: string
    launchArguments: string[]
    call(method: string, params?: Record<string, unknown>): Promise<unknown>
    evaluate(expression: string): Promise<unknown>
  },
  platform: NodeJS.Platform = process.platform,
) {
  await requireDisposablePublicRunner(input.env, input.root, platform)
  requireDefaultDisplayArguments(input.launchArguments)
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.targetId) ||
    (platform === "linux" &&
      (!/^:[0-9]+(?:\.[0-9]+)?$/.test(input.env.DISPLAY ?? "") ||
        input.env.WAYLAND_DISPLAY ||
        input.env.XDG_SESSION_TYPE === "wayland"))
  )
    throw new Error("PLATFORM_DISPLAY_SESSION_UNSUPPORTED")
  const deadline = Date.now() + 45000
  const run = async <T>(operation: Promise<unknown>, expires = deadline) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return (await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("PLATFORM_DISPLAY_TIMEOUT")),
            Math.max(1, Math.min(8000, expires - Date.now())),
          )
        }),
      ])) as T
    } finally {
      clearTimeout(timer)
    }
  }
  const authored = (error: unknown, fallback: string) =>
    error instanceof Error && /^PLATFORM_DISPLAY_[A-Z_]+$/.test(error.message) ? error : new Error(fallback)
  const call = async <T>(method: string, params: Record<string, unknown> = {}, expires = deadline) => {
    try {
      return await run<T>(input.call(method, params), expires)
    } catch (error) {
      const code = method === "Page.captureScreenshot" ? "CAPTURE" : method.startsWith("Input.") ? "INPUT" : "FOCUS"
      throw authored(error, `PLATFORM_DISPLAY_${code}_UNCONFIRMED`)
    }
  }
  const evaluate = <T>(expression: string, expires = deadline) => run<T>(input.evaluate(expression), expires)
  const state = async (expires = deadline) => {
    try {
      return await evaluate<State>(`(${platformDisplayState.toString()})()`, expires)
    } catch (error) {
      throw authored(error, "PLATFORM_DISPLAY_COMPOSER_UNAVAILABLE")
    }
  }
  const ready = (value: State) =>
    value.visible &&
    value.editable &&
    value.rect.width >= 240 &&
    value.rect.height >= 24 &&
    value.rect.x >= 0 &&
    value.rect.y >= 0 &&
    value.rect.x + value.rect.width <= value.width + 1 &&
    value.rect.y + value.rect.height <= value.height + 1
  const until = async <T>(
    read: (expires: number) => Promise<T>,
    accepts: (value: T) => boolean,
    code: string,
    limit = deadline,
  ) => {
    const expires = Math.min(limit, Date.now() + 4000)
    while (Date.now() < expires) {
      const value = await read(expires)
      if (accepts(value)) return value
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(code)
  }
  const frame = async (expires = deadline) => {
    try {
      if (
        (await evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
          expires,
        )) !== true
      )
        throw new Error("PLATFORM_DISPLAY_FRAME_UNCONFIRMED")
    } catch (error) {
      throw authored(error, "PLATFORM_DISPLAY_FRAME_UNCONFIRMED")
    }
  }
  const screenshot = async (value: State, zoom: number, clip = platformDisplayClip(value, zoom)) => {
    // DOM input admission precedes painting. Synchronize once; do not retry a
    // captured blank frame until it passes. The existing deadline bounds rAF.
    await frame()
    const current = await state()
    if (
      !ready(current) ||
      current.text !== value.text ||
      JSON.stringify(platformDisplayClip(current, zoom)) !== JSON.stringify(clip)
    )
      throw new Error("PLATFORM_DISPLAY_GEOMETRY_UNCONFIRMED")
    const image = await call<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip,
    })
    if (
      typeof image?.data !== "string" ||
      image.data.length > 2 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    )
      throw new Error("PLATFORM_DISPLAY_CAPTURE_UNCONFIRMED")
    return image.data
  }
  const pixels = async (before: string, after: string) => {
    let result: { error?: string; observation?: ReturnType<typeof displayPixelEvidence> }
    try {
      result = await evaluate(displayPixelsExpression(before, after))
    } catch (error) {
      throw authored(error, "PLATFORM_DISPLAY_DECODE_UNCONFIRMED")
    }
    if (
      result?.error &&
      [
        "PLATFORM_DISPLAY_PAINT_UNCONFIRMED",
        "PLATFORM_DISPLAY_DIMENSIONS_UNCONFIRMED",
        "PLATFORM_DISPLAY_DECODE_UNCONFIRMED",
      ].includes(result.error)
    )
      throw new Error(result.error)
    const observation = result?.observation
    if (
      !observation ||
      !Object.values(observation).every(Number.isInteger) ||
      observation.width < 120 ||
      observation.width > 1024 ||
      observation.height < 16 ||
      observation.height > 256 ||
      observation.changedPixels < 120 ||
      observation.contrastingPixels < 120 ||
      observation.changedPixels > observation.width * observation.height ||
      observation.contrastingPixels > observation.width * observation.height
    )
      throw new Error("PLATFORM_DISPLAY_PAINT_UNCONFIRMED")
    return observation
  }
  const key = async (key: string, code: string, virtual: number, modifiers = 0, expires = deadline) => {
    await call(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key, code, windowsVirtualKeyCode: virtual, modifiers },
      expires,
    )
    await call(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key, code, windowsVirtualKeyCode: virtual, modifiers },
      expires,
    )
  }
  const clear = async (expires = deadline) => {
    await key("a", "KeyA", 65, 2, expires)
    await key("Backspace", "Backspace", 8, 0, expires)
  }
  const nativeState = (expires = deadline) =>
    evaluate<{ focused: boolean; fullscreen: boolean; zoom: number }>(
      "(async () => ({ focused: await window.api.getWindowFocused(), fullscreen: await window.api.getWindowFullscreen(), zoom: await window.api.getZoomFactor() }))()",
      expires,
    )
  const native = await nativeState()
  if (!Number.isFinite(native.zoom) || native.zoom < 0.5 || native.zoom > 3 || typeof native.fullscreen !== "boolean")
    throw new Error("PLATFORM_DISPLAY_WINDOW_UNCONFIRMED")
  const initial = await state()
  if (!ready(initial) || initial.text !== "") throw new Error("PLATFORM_DISPLAY_COMPOSER_UNAVAILABLE")
  const focus = await call<{ result?: { objectId?: string }; exceptionDetails?: unknown }>("Runtime.evaluate", {
    expression: "document.activeElement",
    returnByValue: false,
  })
  if (!focus.result?.objectId || focus.exceptionDetails) throw new Error("PLATFORM_DISPLAY_FOCUS_UNCONFIRMED")
  let entered = false
  let zoomed = false
  let pressed = false
  let position: { x: number; y: number } | undefined
  let paint: Awaited<ReturnType<typeof pixels>> | undefined
  let failed: Error | undefined
  try {
    await call("Page.bringToFront")
    // First-launch navigation can move the composer after its initial DOM is
    // ready. Sample its current painted, unobstructed position before one click.
    let previous: State | undefined
    const pointer = await until(
      async (expires) => {
        await frame(expires)
        return state(expires)
      },
      (value) => {
        const prior = previous
        previous = ready(value) && value.pointerHitsComposer && value.text === "" ? value : undefined
        return Boolean(
          previous &&
            prior &&
            value.width === prior.width &&
            value.height === prior.height &&
            value.scrollX === prior.scrollX &&
            value.scrollY === prior.scrollY &&
            JSON.stringify(value.rect) === JSON.stringify(prior.rect),
        )
      },
      "PLATFORM_DISPLAY_POINTER_UNCONFIRMED",
    )
    position = {
      x: pointer.rect.x + Math.min(pointer.rect.width / 2, 120),
      y: pointer.rect.y + pointer.rect.height / 2,
    }
    pressed = true
    await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...position })
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...position })
    pressed = false
    let focusFailure = "PLATFORM_DISPLAY_FOCUS_UNCONFIRMED"
    const focused = await until(
      async (expires) => {
        const value = await state(expires)
        const window = await nativeState(expires)
        focusFailure =
          !ready(value) || value.text !== ""
            ? "PLATFORM_DISPLAY_COMPOSER_UNAVAILABLE"
            : !value.focused
              ? "PLATFORM_DISPLAY_DOCUMENT_FOCUS_UNCONFIRMED"
              : !value.composerFocused
                ? "PLATFORM_DISPLAY_COMPOSER_FOCUS_UNCONFIRMED"
                : !window.focused
                  ? "PLATFORM_DISPLAY_NATIVE_FOCUS_UNCONFIRMED"
                  : "READY"
        return value
      },
      () => focusFailure === "READY",
      "PLATFORM_DISPLAY_FOCUS_UNCONFIRMED",
    ).catch((error) => {
      if (error.message === "PLATFORM_DISPLAY_FOCUS_UNCONFIRMED") throw new Error(focusFailure)
      throw error
    })
    const clip = platformDisplayClip(focused, native.zoom)
    const empty = await screenshot(focused, native.zoom, clip)
    entered = true
    await call("Input.insertText", { text: marker })
    const typed = await until(
      state,
      (value) => ready(value) && value.text === marker,
      "PLATFORM_DISPLAY_INPUT_UNCONFIRMED",
    )
    paint = await pixels(empty, await screenshot(typed, native.zoom, clip))
    // Native keyboard editing must reach the genuine composer handler.
    await clear()
    await until(state, (value) => value.text === "", "PLATFORM_DISPLAY_INPUT_UNCONFIRMED")
    entered = false
    zoomed = true
    const nextZoom = native.zoom <= 2.5 ? native.zoom + 0.2 : native.zoom - 0.2
    try {
      await evaluate(`window.api.setZoomFactor(${nextZoom})`)
    } catch (error) {
      throw authored(error, "PLATFORM_DISPLAY_WINDOW_UNCONFIRMED")
    }
    await until(
      nativeState,
      (value) => Math.abs(value.zoom - nextZoom) < 0.000001 && value.fullscreen === native.fullscreen,
      "PLATFORM_DISPLAY_WINDOW_UNCONFIRMED",
    )
    const reflowed = await until(
      state,
      (value) => ready(value) && value.width !== initial.width && value.height !== initial.height && value.text === "",
      "PLATFORM_DISPLAY_WINDOW_UNCONFIRMED",
    )
    const zoomedClip = platformDisplayClip(reflowed, nextZoom)
    const zoomedEmpty = await screenshot(reflowed, nextZoom, zoomedClip)
    entered = true
    await call("Input.insertText", { text: marker })
    const repainted = await until(
      state,
      (value) => ready(value) && value.text === marker,
      "PLATFORM_DISPLAY_INPUT_UNCONFIRMED",
    )
    await pixels(zoomedEmpty, await screenshot(repainted, nextZoom, zoomedClip))
  } catch (error) {
    failed =
      error instanceof Error && /^PLATFORM_DISPLAY_[A-Z_]+$/.test(error.message)
        ? error
        : new Error("PLATFORM_DISPLAY_PROBE_UNCONFIRMED")
  } finally {
    const expires = Date.now() + 20000
    try {
      if (pressed)
        await call(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", button: "left", clickCount: 1, ...position },
          expires,
        )
      if (entered) {
        await evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`, expires)
        await clear(expires)
      }
      if (zoomed) await evaluate(`window.api.setZoomFactor(${native.zoom})`, expires)
      await until(
        async () => {
          const restored = await evaluate<State>(`(${platformDisplayState.toString()})()`, expires)
          const restoredNative = await nativeState(expires)
          return (
            restored.text === "" &&
            restored.width === initial.width &&
            restored.height === initial.height &&
            restored.outerWidth === initial.outerWidth &&
            restored.outerHeight === initial.outerHeight &&
            restored.screenX === initial.screenX &&
            restored.screenY === initial.screenY &&
            restoredNative.fullscreen === native.fullscreen &&
            Math.abs(restoredNative.zoom - native.zoom) < 0.000001
          )
        },
        (value) => value,
        "PLATFORM_DISPLAY_RESTORE_UNCONFIRMED",
        expires,
      )
      const result = await call<{ result?: { value?: boolean } }>(
        "Runtime.callFunctionOn",
        {
          objectId: focus.result.objectId,
          returnByValue: true,
          functionDeclaration:
            "function() { if (!this.isConnected) return false; if (this === document.body) document.activeElement?.blur(); else this.focus(); return document.activeElement === this; }",
        },
        expires,
      )
      if (result.result?.value !== true) throw new Error("PLATFORM_DISPLAY_RESTORE_UNCONFIRMED")
    } catch {
      failed = new Error("PLATFORM_DISPLAY_RESTORE_UNCONFIRMED")
    }
    await call("Runtime.releaseObject", { objectId: focus.result.objectId }, expires).catch(() => {})
  }
  if (failed) throw failed
  return {
    scope: platform === "win32" ? "windows-hosted-desktop" : "linux-x11-xvfb",
    defaultGraphicsArguments: true,
    nativeWindowVisible: true,
    composerPointerFocus: true,
    keyboardEditing: true,
    compositorPaint: true,
    nativeWindowFocused: true,
    zoomRepaint: true,
    restoredDraftFocusAndZoom: true,
    arbitraryNativeResizeTested: false,
    pixels: paint,
    gpuHardwareVerified: false,
    waylandTested: false,
    physicalDisplayMeasured: false,
    opticalFlickerMeasured: false,
  }
}
