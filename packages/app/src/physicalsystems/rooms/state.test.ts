import { expect, test } from "bun:test"
import { acceptsRoom, prepareTaskPrompt, roomAccessDenied, roomResourceHref, workcellPath } from "./state"
import type { WorkcellRoomData } from "./types"
test("late responses cannot replace another room or roll its activity backwards", () => {
  const current = { id: "a", lastEventSequence: 8 } as WorkcellRoomData
  expect(acceptsRoom(current, { id: "b", lastEventSequence: 9 } as WorkcellRoomData, "a")).toBe(false)
  expect(acceptsRoom(current, { id: "a", lastEventSequence: 7 } as WorkcellRoomData, "a")).toBe(false)
  expect(acceptsRoom(current, { id: "a", lastEventSequence: 9 } as WorkcellRoomData, "a")).toBe(true)
})
test("room navigation cannot become a filesystem or external authority", () => {
  expect(workcellPath("cell-123")).toBe("/api/workcells/cell-123")
  for (const value of ["../desktop/account", "a?token=secret", "//evil.test"]) {
    expect(() => workcellPath(value)).toThrow()
  }
  expect(roomResourceHref("/dashboard/services")).toBe("/dashboard/services")
  for (const value of ["javascript:alert(1)", "//evil.test", "https://evil.test", "/a\n"]) {
    expect(roomResourceHref(value)).toBeUndefined()
  }
})

test("access denial clears rooms while offline errors retain retryable state", () => {
  for (const error of [
    { status: 401 },
    { status: 403 },
    { status: 404 },
    new Error("Error invoking remote method: WORKCELL_ACCESS_REVOKED"),
  ])
    expect(roomAccessDenied(error)).toBe(true)
  expect(roomAccessDenied(new Error("UNAVAILABLE"))).toBe(false)
})
test("Assistant context is one editable task brief without conversation replay or execution", () => {
  const room = {
    id: "cell-1",
    name: "Packing",
    task: "Pack components",
    objects: "parts",
    volume: "100/day",
    location: "Ghent",
    companyName: "Example",
    messages: [{ content: "unrelated update" }],
  } as WorkcellRoomData
  const prompt = prepareTaskPrompt(room)
  expect(prompt).toContain("Do not start physical execution")
  expect(prompt).toContain('"task": "Pack components"')
  expect(prompt).toContain("https://physicalsystems.ai/dashboard/workcells/cell-1")
  expect(prompt).not.toContain("unrelated update")
})
test("worst-case task briefs fit the existing Assistant limit and disclose excerpts", () => {
  const room = {
    id: "cell-1",
    name: "Packing",
    companyName: "Example",
    task: '"\\\n'.repeat(2666),
    objects: '"\\'.repeat(1000),
    volume: "1000".repeat(100),
    location: "Ghent".repeat(100),
  } as WorkcellRoomData
  const prompt = prepareTaskPrompt(room)
  expect(prompt.length).toBeLessThanOrEqual(2000)
  expect(prompt).toContain("Some context below is excerpted")
  expect(prompt).toContain("https://physicalsystems.ai/dashboard/workcells/cell-1")
  expect(JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)).task.length).toBeGreaterThan(0)
  expect(room.task.length).toBe(7998)
})
