import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { openExternalTarget, resolveExternalURL, resolveLocalFilePath } from "./external-url"

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
