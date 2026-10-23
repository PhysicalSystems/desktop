import { describe, expect, test } from "bun:test"
import { createDesktopLaunchController } from "./desktop-launch"

function windowFixture(options: { minimized?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    window: {
      isDestroyed: () => options.destroyed ?? false,
      isMinimized: () => options.minimized ?? false,
      restore: () => { calls.push("restore") },
      show: () => { calls.push("show") },
      focus: () => { calls.push("focus") },
    },
  }
}

describe("Physical Systems website launch", () => {
  test("restores a minimized app before showing and focusing it", () => {
    const fixture = windowFixture({ minimized: true })
    expect(createDesktopLaunchController().receive("physicalsystems://open", fixture.window)).toBe(true)
    expect(fixture.calls).toEqual(["restore", "show", "focus"])
  })

  test("raises an existing window without changing its session or restoring an unminimized window", () => {
    const fixture = windowFixture()
    expect(createDesktopLaunchController().receive("physicalsystems://open", fixture.window)).toBe(true)
    expect(fixture.calls).toEqual(["show", "focus"])
  })

  test("cold and early launches wait for normal startup and focus only one ready window", () => {
    const controller = createDesktopLaunchController()
    const first = windowFixture()
    const second = windowFixture()
    expect(controller.receive("physicalsystems://open")).toBe(true)
    expect(controller.receive("physicalsystems://open", null)).toBe(true)
    expect(first.calls).toEqual([])
    controller.ready(first.window)
    controller.ready(second.window)
    expect(first.calls).toEqual(["show", "focus"])
    expect(second.calls).toEqual([])
  })

  test("a closed window cannot consume the launch intended for the next ready window", () => {
    const controller = createDesktopLaunchController()
    const closed = windowFixture({ destroyed: true })
    const ready = windowFixture()
    controller.receive("physicalsystems://open", closed.window)
    expect(closed.calls).toEqual([])
    controller.ready(ready.window)
    expect(ready.calls).toEqual(["show", "focus"])
  })

  test("consumes unsupported Physical Systems URLs without opening or queuing anything", () => {
    for (const value of [
      "physicalsystems://open/", "physicalsystems://open?", "physicalsystems://open#",
      "physicalsystems://open?prompt=run", "physicalsystems://open?directory=C%3A%5Cprivate",
      "physicalsystems://open?token=credential", "physicalsystems://open#credential",
      "physicalsystems://user:password@open", "physicalsystems://open:1234",
      "physicalsystems://open/workcells/123", "physicalsystems://workcells/123",
      "physicalsystems://%6fpen", "physicalsystems://open/../", "physicalsystems:open",
      "physicalsystems:///open", "physicalsystems://open\n", "PHYSICALSYSTEMS://OPEN",
    ]) {
      const controller = createDesktopLaunchController()
      const fixture = windowFixture()
      expect(controller.receive(value, fixture.window)).toBe(true)
      controller.ready(fixture.window)
      expect(fixture.calls).toEqual([])
    }
  })

  test("unrelated protocols and ordinary startup do not request a focus action", () => {
    const controller = createDesktopLaunchController()
    const fixture = windowFixture()
    for (const value of [undefined, null, 1, {}, "", "https://physicalsystems.ai", "opencode://open-project?directory=/tmp/project"]) {
      expect(controller.receive(value, fixture.window)).toBe(false)
    }
    controller.ready(fixture.window)
    expect(fixture.calls).toEqual([])
  })
})
