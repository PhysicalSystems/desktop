import { expect, test } from "bun:test"
import { rendererStoreName } from "./renderer-store"

test("renderer stores accept existing logical names but cannot reach a main-owned journal", () => {
  for (const name of [
    "default.dat",
    "opencode.global.dat",
    "opencode.settings",
    "opencode.workspace.home-lienert.a10f.dat",
    "opencode.window.1.dat",
  ])
    expect(rendererStoreName(name)).toBe(name)
  for (const name of [
    undefined,
    null,
    {},
    "",
    ".",
    "..",
    "../main/preview-update",
    "main/preview-update",
    "main\\preview-update",
    "C:\\main\\preview-update",
    "main:preview-update",
    "main.",
    "main ",
    "main\0",
    "physicalsystems.preview-updater",
    "PHYSICALSYSTEMS.PREVIEW-UPDATER",
    "./physicalsystems.preview-updater",
    "physicalsystems.preview-updater.",
    "a".repeat(201),
  ])
    expect(() => rendererStoreName(name)).toThrow("INVALID_RENDERER_STORE")
})
