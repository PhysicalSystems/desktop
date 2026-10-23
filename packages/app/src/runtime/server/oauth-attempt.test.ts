import { expect, test } from "bun:test"
import { createOAuthAttempt, oauthBrowserURL } from "./oauth-attempt"

test("method changes and closing discard late authorizations without invalidating a newer attempt", async () => {
  const cancelled: string[] = []
  const flow = createOAuthAttempt(async (value) => {
    cancelled.push(value.attemptID)
  })
  const first = flow.begin()
  const second = flow.begin()
  expect(flow.accept(second, { attemptID: "current" })).toBe(true)
  expect(flow.accept(first, { attemptID: "late" })).toBe(false)
  expect(flow.current(first)).toBe(false)
  expect(flow.current(second, "current")).toBe(true)
  expect(flow.current(second, "late")).toBe(false)
  flow.begin()
  expect(flow.current(second, "current")).toBe(false)
  await Promise.resolve()
  await Promise.resolve()
  expect(cancelled).toEqual(["late", "current"])
})

test("confirmed completion releases the attempt without cancelling it; cancellation errors are contained", async () => {
  let cancels = 0
  const flow = createOAuthAttempt(async () => {
    cancels++
    throw new Error("unavailable")
  })
  const first = flow.begin()
  flow.accept(first, { attemptID: "saved" })
  flow.begin(false)
  await Promise.resolve()
  expect(cancels).toBe(0)
  expect(flow.accept(first, { attemptID: "late" })).toBe(false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(cancels).toBe(1)
})

test("sign-in links permit only bounded web URLs without embedded credentials", () => {
  expect(oauthBrowserURL("https://example.com/authorize?state=abc")).toBe("https://example.com/authorize?state=abc")
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/auth",
    "mailto:a@b.com",
    "https://user:secret@example.com",
    "x".repeat(8193),
  ])
    expect(oauthBrowserURL(url)).toBeUndefined()
})
