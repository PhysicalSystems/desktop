// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildEnvironment, emptyOutput, releaseArguments } from "./commands"
import type { ReleaseInputs } from "./inputs"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function workspace() {
  const folder = await mkdtemp(path.join(tmpdir(), "physical-release-commands-"))
  directories.push(folder)
  const root = path.join(folder, "source")
  await mkdir(root)
  return { folder, root }
}

describe("desktop candidate CLI arguments", () => {
  const prepare = [
    "prepare",
    "--source-sha",
    "a".repeat(40),
    "--repository",
    "PhysicalSystems/desktop",
    "--channel",
    "preview",
    "--history",
    "/review/history.json",
    "--output",
    "/review/candidate",
  ]

  test("allows automatic preview allocation and an explicit candidate version", () => {
    expect(releaseArguments(prepare)).toEqual({
      command: "prepare",
      options: {
        "source-sha": "a".repeat(40),
        repository: "PhysicalSystems/desktop",
        channel: "preview",
        history: "/review/history.json",
        output: "/review/candidate",
      },
    })
    expect(releaseArguments([...prepare, "--version", "0.1.0-beta.2"]).options.version).toBe("0.1.0-beta.2")
  })

  test("has no publish command or publish override and rejects ambiguous arguments", () => {
    for (const args of [
      ["publish"],
      [],
      ["prepare"],
      [...prepare, "--publish", "always"],
      [...prepare, "--channel", "stable"],
      [...prepare, "--version"],
      [...prepare, "--version", "--force"],
      [...prepare, "version", "0.1.0"],
    ])
      expect(() => releaseArguments(args)).toThrow()
    expect(() => releaseArguments(["build", "--inputs", "/inputs.json", "--output", "/review/build"])).toThrow(
      "Missing --platform",
    )
    expect(() =>
      releaseArguments([
        "verify-artifacts",
        "--inputs",
        "/inputs.json",
        "--artifacts",
        "/review/build",
        "--output",
        "/review/result",
      ]),
    ).toThrow("Missing --receipts")
  })

  test("carries paths as literal arguments without expanding shell syntax", () => {
    const file = "/review folder/$(not-a-command)/inputs.json"
    expect(releaseArguments(["verify-inputs", "--inputs", file]).options.inputs).toBe(file)
  })
})

describe("candidate build environment", () => {
  test("scrubs provider, signing and CI secrets while preserving tool discovery", () => {
    const source = {
      PATH: "/toolchain/bin",
      HOME: "/isolated/profile",
      SYSTEMROOT: "C:\\Windows",
      OPENAI_API_KEY: "fixture-openai",
      ANTHROPIC_AUTH_TOKEN: "fixture-anthropic",
      CUSTOM_SECRET: "fixture-secret",
      AWS_PROFILE: "fixture-profile",
      AZURE_CLIENT_ID: "fixture-azure",
      GH_TOKEN: "fixture-github",
      GITHUB_TOKEN: "fixture-github-actions",
      CSC_LINK: "fixture-signing-certificate",
      WIN_CSC_LINK: "fixture-windows-certificate",
      WIN_CSC_KEY_PASSWORD: "fixture-signing-password",
      APPLE_ID: "fixture-apple",
      SENTRY_AUTH_TOKEN: "fixture-sentry",
      VITE_SENTRY_DSN: "fixture-telemetry",
    }
    const copy = structuredClone(source)
    const result = buildEnvironment(
      source,
      { version: "0.1.0-beta.1" } as ReleaseInputs,
      "/inputs.json",
      "/models.json",
    )
    expect(source).toEqual(copy)
    expect(result.PATH).toBe(source.PATH)
    expect(result.HOME).toBe(source.HOME)
    expect(result.SYSTEMROOT).toBe(source.SYSTEMROOT)
    for (const key of Object.keys(source).filter((key) => !["PATH", "HOME", "SYSTEMROOT"].includes(key)))
      expect(result[key]).toBeUndefined()
  })

  test("overrides ambient product, device and signing mode with the exact candidate inputs", () => {
    const result = buildEnvironment(
      {
        OPENCODE_VERSION: "9.9.9",
        OPENCODE_CHANNEL: "latest",
        PHYSICALSYSTEMS_ALLOW_DEVICES: "1",
        PHYSICALSYSTEMS_RELEASE_INPUTS: "/untrusted.json",
        MODELS_DEV_API_JSON: "/mutable-models.json",
        CSC_IDENTITY_AUTO_DISCOVERY: "true",
        NODE_OPTIONS: "--require /ambient-hook.js",
      },
      { version: "0.1.0-beta.3" } as ReleaseInputs,
      "/verified/inputs.json",
      "/verified/models.json",
    )
    expect(result.OPENCODE_VERSION).toBe("0.1.0-beta.3")
    expect(result.OPENCODE_CHANNEL).toBe("dev")
    expect(result.PHYSICALSYSTEMS_ALLOW_DEVICES).toBe("0")
    expect(result.PHYSICALSYSTEMS_RELEASE_INPUTS).toBe("/verified/inputs.json")
    expect(result.MODELS_DEV_API_JSON).toBe("/verified/models.json")
    expect(result.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false")
    expect(result.NODE_OPTIONS).toBe("--max-old-space-size=3072")
  })
})

describe("isolated candidate output directories", () => {
  test("creates only a new external directory, allowing an existing empty directory", async () => {
    const data = await workspace()
    const target = path.join(data.folder, "candidate")
    expect(await emptyOutput(target, data.root)).toBe(target)
    expect((await lstat(target)).isDirectory()).toBe(true)
    expect(await emptyOutput(target, data.root)).toBe(target)
    if (process.platform !== "win32") expect((await lstat(target)).mode & 0o777).toBe(0o700)
  })

  test("rejects source paths and preserves existing user configuration bytes", async () => {
    const data = await workspace()
    await expect(emptyOutput("candidate", data.root)).rejects.toThrow("absolute")
    await expect(emptyOutput(data.root, data.root)).rejects.toThrow("outside")
    await expect(emptyOutput(path.join(data.root, "candidate"), data.root)).rejects.toThrow("outside")
    const existing = path.join(data.folder, "existing-profile")
    await mkdir(existing)
    const config = path.join(existing, "settings.json")
    const bytes = '{"existing":"preserve this configuration"}\n'
    await writeFile(config, bytes)
    await expect(emptyOutput(existing, data.root)).rejects.toThrow("empty real directory")
    await expect(emptyOutput(config, data.root)).rejects.toThrow("empty real directory")
    expect(await readFile(config, "utf8")).toBe(bytes)
  })

  test("rejects final symlinks and parent aliases that redirect into source", async () => {
    const data = await workspace()
    const alias = path.join(data.folder, "source-alias")
    await symlink(data.root, alias, process.platform === "win32" ? "junction" : "dir")
    await expect(emptyOutput(path.join(alias, "candidate"), data.root)).rejects.toThrow("outside")
    const outside = path.join(data.folder, "external-empty")
    await mkdir(outside)
    const finalAlias = path.join(data.folder, "candidate-alias")
    await symlink(outside, finalAlias, process.platform === "win32" ? "junction" : "dir")
    await expect(emptyOutput(finalAlias, data.root)).rejects.toThrow("empty real directory")
    expect((await lstat(finalAlias)).isSymbolicLink()).toBe(true)
  })
})
