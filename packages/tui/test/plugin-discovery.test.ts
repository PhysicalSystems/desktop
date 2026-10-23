import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { discoverPluginTargets, localPluginDirectories, mergePluginTargets } from "../src/plugin/discovery"
import { tmpdir } from "./fixture/fixture"

test("deduplicates equivalent local plugin targets while retaining the final source", () => {
  const directory = "/project"
  const discovered = { entry: "/project/.opencode/plugins/example", install: true, optional: true }
  const server = { entry: "./.opencode/plugins/example", install: false, optional: true }

  expect(mergePluginTargets([discovered, server], directory)).toEqual([server])
})

test("preserves the first target position when a later source overrides it", () => {
  const first = { entry: "example", install: true, optional: true }
  const other = { entry: "other", install: true, optional: true }
  const configured = { entry: { package: "example", options: { enabled: true } }, install: true, optional: false }

  expect(mergePluginTargets([first, other, configured], "/project")).toEqual([configured, other])
})

test("Physical Systems attachment rejects local, global, configured and server TUI targets before scanning", async () => {
  await using root = await tmpdir()
  const directory = path.join(root.path, "plugins")
  const plugin = path.join(directory, "unreviewed")
  const notDirectory = path.join(root.path, "not-a-directory")
  await mkdir(plugin, { recursive: true })
  await writeFile(notDirectory, "inert")
  const targets = [
    { entry: plugin, install: true, optional: true },
    { entry: "unreviewed-configured", install: true, optional: false },
    { entry: "unreviewed-server", install: false, optional: true },
  ]
  const flags = ["PHYSICALSYSTEMS_DESKTOP", "PHYSICALSYSTEMS_AGENT_URL", "PHYSICALSYSTEMS_AGENT_TOKEN"] as const
  const before = Object.fromEntries(flags.map((key) => [key, process.env[key]]))
  try {
    flags.forEach((key) => delete process.env[key])
    expect(await discoverPluginTargets([directory])).toEqual([plugin])
    expect(mergePluginTargets(targets, root.path)).toEqual(targets)
    for (const key of flags) {
      // The presence of even a malformed bridge address/token must fail closed.
      process.env[key] = key === "PHYSICALSYSTEMS_DESKTOP" ? "1" : ""
      expect(await localPluginDirectories(root.path, directory)).toEqual([])
      expect(await discoverPluginTargets([directory, notDirectory])).toEqual([])
      expect(mergePluginTargets(targets, root.path)).toEqual([])
      delete process.env[key]
    }
  } finally {
    for (const key of flags) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  }
})
