// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync, spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildEnvironment,
  DesktopCommandFailure,
  emptyOutput,
  qualifyCandidateArtifacts,
  releaseArguments,
  run,
  stageCandidateSource,
} from "./commands"
import { candidateNames, createInventory } from "./artifacts"
import type { CandidateArtifact, CandidateInventory, Qualification } from "./artifacts"
import { requiredQualificationChecks } from "./qualification"
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

async function qualificationFixture() {
  const { folder } = await workspace()
  const artifacts = path.join(folder, "artifacts")
  const output = path.join(folder, "receipts")
  const evidence = path.join(folder, "private-evidence")
  await Promise.all([artifacts, output, evidence].map((directory) => mkdir(directory)))
  const inputs = {
    version: "0.1.0-beta.1",
    channel: "preview" as const,
    sha256: "a".repeat(64),
    source: {
      revision: "b".repeat(40),
      tree: "c".repeat(40),
      repository: "PhysicalSystems/desktop",
      upstream: { repository: "https://github.com/anomalyco/opencode", revision: "d".repeat(40) },
    },
  }
  for (const item of candidateNames(inputs.version, "linux-x64"))
    await writeFile(path.join(artifacts, item.name), "inert package " + item.format)
  const inventory = await createInventory(artifacts, inputs, "linux-x64")
  return { inventory, artifacts, output, evidence, env: {} }
}

function qualificationReceipt(artifact: CandidateArtifact, inventory: CandidateInventory): Qualification {
  return {
    schemaVersion: 1,
    artifact: { name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes },
    inputsSha256: inventory.inputsSha256,
    sourceRevision: inventory.sourceRevision,
    version: inventory.version,
    platform: inventory.platform,
    simulationOnly: true,
    opticalFlickerMeasured: false,
    deviceConnectionsAllowed: false,
    payload: { sha256: "e".repeat(64), executableSha256: "f".repeat(64) },
    signature: { status: "NOT_TESTED", trust: "NOT_APPLICABLE_TO_LINUX_PACKAGE" },
    publicDistribution: { status: "BLOCKED", reason: "Inert loop-control fixture" },
    result: "PASS",
    checks: [
      ...new Set([
        ...requiredQualificationChecks,
        "linux-sandbox-setup",
        "linux-renderer-sandbox",
        "native-secret-service-cleanup",
        "linux-temporary-cleanup",
        ...(artifact.format === "AppImage" ? ["appimage-launcher", "linux-sandbox-cleanup"] : ["uninstall"]),
      ]),
    ].map((id) => ({ id, status: "PASS" as const })),
  }
}

describe("candidate qualification continuation", () => {
  test("a cleanly torn down failed test preserves its receipt, tests the next format and still fails overall", async () => {
    const input = await qualificationFixture()
    const started: string[] = []
    let firstReceipt = ""
    await expect(
      qualifyCandidateArtifacts(input, async (_exe, args) => {
        const artifact = input.inventory.files[started.length]!
        started.push(artifact.name)
        expect(args[args.indexOf("--artifact") + 1]).toBe(path.join(input.artifacts, artifact.name))
        const report = qualificationReceipt(artifact, input.inventory)
        if (started.length === 1) {
          report.result = "FAIL"
          report.checks.find((check) => check.id === "synthetic-chat")!.status = "FAIL"
        }
        const text = JSON.stringify(report)
        if (started.length === 1) firstReceipt = text
        await writeFile(args[args.indexOf("--report") + 1]!, text)
        if (started.length === 1) throw new DesktopCommandFailure("exit")
      }),
    ).rejects.toThrow("Packaged candidate qualification failed")
    expect(started).toEqual(input.inventory.files.map((artifact) => artifact.name))
    expect(await readFile(path.join(input.output, started[0] + ".qualification.json"), "utf8")).toBe(firstReceipt)
  })

  test("missing, blocked or failed teardown and malformed/stale receipts never start the second installer", async () => {
    for (const variation of [
      "missing",
      "invalid-json",
      "stale",
      "duplicate",
      "cleanup",
      "uninstall",
      "native-secret-service-cleanup",
      "linux-temporary-cleanup",
      "linux-sandbox-cleanup",
      "browser-uncertain",
      "runtime-uncertain",
    ]) {
      const input = await qualificationFixture()
      if (variation === "linux-sandbox-cleanup") input.inventory.files.reverse()
      const started: string[] = []
      await expect(
        qualifyCandidateArtifacts(input, async (_exe, args) => {
          const artifact = input.inventory.files[started.length]!
          started.push(artifact.name)
          if (variation === "missing") throw new DesktopCommandFailure("exit")
          const report = qualificationReceipt(artifact, input.inventory)
          if (variation === "stale") report.artifact.sha256 = "9".repeat(64)
          else if (variation === "duplicate") report.checks.push({ id: "cleanup", status: "PASS" })
          else if (variation === "browser-uncertain")
            report.checks.push({
              id: "native-browser-handoff-probe",
              status: "FAIL",
              failureCode: "BROWSER_HANDOFF_CLEANUP_UNCONFIRMED",
            })
          else if (variation === "runtime-uncertain")
            report.checks.push({ id: "runtime-cleanup", status: "NOT_TESTED" })
          else if (!["invalid-json"].includes(variation))
            report.checks.find((check) => check.id === variation)!.status = "BLOCKED"
          await writeFile(
            args[args.indexOf("--report") + 1]!,
            variation === "invalid-json" ? "invalid-json" : JSON.stringify(report),
          )
          throw new DesktopCommandFailure("exit")
        }),
      ).rejects.toThrow("remaining installers were not started")
      expect(started).toEqual([input.inventory.files[0]!.name])
    }
  })

  test("timeouts, signals, failed startup and unknown runner outcomes stop even with an apparently complete receipt", async () => {
    for (const outcome of ["timeout", "signal", "start", "unknown"] as const) {
      const input = await qualificationFixture()
      let started = 0
      await expect(
        qualifyCandidateArtifacts(input, async (_exe, args) => {
          const artifact = input.inventory.files[started++]!
          await writeFile(
            args[args.indexOf("--report") + 1]!,
            JSON.stringify(qualificationReceipt(artifact, input.inventory)),
          )
          throw outcome === "unknown" ? Error("PRIVATE-RUNNER-ERROR") : new DesktopCommandFailure(outcome)
        }),
      ).rejects.toThrow("remaining installers were not started")
      expect(started).toBe(1)
    }
  })

  test("both successful installer runs still require their exact qualification receipts", async () => {
    const input = await qualificationFixture()
    let started = 0
    await qualifyCandidateArtifacts(input, async (_exe, args) => {
      const artifact = input.inventory.files[started++]!
      await writeFile(
        args[args.indexOf("--report") + 1]!,
        JSON.stringify(qualificationReceipt(artifact, input.inventory)),
      )
    })
    expect(started).toBe(2)
  })

  test("an already-existing receipt cannot stand in for a newly invoked qualification", async () => {
    const input = await qualificationFixture()
    const artifact = input.inventory.files[0]!
    const receipt = path.join(input.output, artifact.name + ".qualification.json")
    const bytes = JSON.stringify(qualificationReceipt(artifact, input.inventory))
    await writeFile(receipt, bytes)
    let started = 0
    await expect(
      qualifyCandidateArtifacts(input, async () => {
        started++
      }),
    ).rejects.toThrow("receipt already exists")
    expect(started).toBe(0)
    expect(await readFile(receipt, "utf8")).toBe(bytes)
  })

  test("actual inert child outcomes distinguish failed exit from timeout and unsuccessful startup", async () => {
    const { folder } = await workspace()
    for (const [exe, args, timeout, outcome] of [
      [process.execPath, ["-e", "process.exit(7)"], 2000, "exit"],
      [process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 20, "timeout"],
      [path.join(folder, "missing-runtime"), [], 2000, "start"],
    ] as const) {
      const failure = await run(exe, [...args], folder, {}, timeout).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DesktopCommandFailure)
      expect((failure as DesktopCommandFailure).outcome).toBe(outcome)
    }
  })

  test("a timed-out inert child that ignores SIGTERM cannot retain the controller until its own expiry", async () => {
    if (process.platform === "win32") return // Windows termination does not deliver POSIX SIGTERM handlers.
    const { folder } = await workspace()
    const ready = path.join(folder, "ready")
    const expired = path.join(folder, "expired")
    const outcome = path.join(folder, "outcome")
    const controller = path.join(folder, "controller.ts")
    const commands = path.join(import.meta.dir, "commands.ts")
    const childSource = `import {writeFileSync} from "node:fs"; process.on("SIGTERM",()=>{}); writeFileSync(${JSON.stringify(ready)},"ready"); setTimeout(()=>writeFileSync(${JSON.stringify(expired)},String(Date.now())),1200);`
    await writeFile(
      controller,
      `import {run,DesktopCommandFailure} from ${JSON.stringify(commands)}; import {writeFileSync} from "node:fs"; try { await run(process.execPath,["-e",${JSON.stringify(childSource)}],${JSON.stringify(folder)},{},300); } catch(error) { writeFileSync(${JSON.stringify(outcome)},JSON.stringify({outcome:error instanceof DesktopCommandFailure?error.outcome:"unknown",at:Date.now()})); }`,
    )
    const child = spawn(process.execPath, [controller], { env: {}, stdio: ["ignore", "pipe", "pipe"] })
    const closed = new Promise<void>((resolve, reject) => {
      child.once("close", (code) => (code === 0 ? resolve() : reject(Error("INERT_CONTROLLER_FAILED"))))
      child.once("error", reject)
    })
    const exitedAt = await new Promise<number>((resolve) => child.once("exit", () => resolve(Date.now())))
    expect(await readFile(ready, "utf8")).toBe("ready")
    const result = JSON.parse(await readFile(outcome, "utf8"))
    expect(result.outcome).toBe("timeout")
    await closed
    expect(Number(await readFile(expired, "utf8"))).toBeGreaterThan(exitedAt)
  })
})

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
        USE_HARD_LINKS: "true",
        VITEST: "true",
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
    expect(result.USE_HARD_LINKS).toBeUndefined()
    expect(result.VITEST).toBeUndefined()
  })
})

describe("isolated candidate output directories", () => {
  test("creates only a new external directory, allowing an existing empty directory", async () => {
    const data = await workspace()
    const target = path.join(data.folder, "candidate")
    expect(await emptyOutput(target, data.root)).toBe(await realpath(target))
    expect((await lstat(target)).isDirectory()).toBe(true)
    expect(await emptyOutput(target, data.root)).toBe(await realpath(target))
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

test("stages exact committed bytes with real Git and tar on native drive paths", async () => {
  const data = await workspace()
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", data.root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "--quiet")
  const tracked = path.join(data.root, "tracked.txt")
  await writeFile(tracked, "committed candidate bytes\n")
  git("add", ".")
  git(
    "-c",
    "user.name=Release fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "test: archive fixture",
  )
  const revision = git("rev-parse", "HEAD")
  await writeFile(tracked, "later working tree changes\n")
  await writeFile(path.join(data.root, "private-untracked.txt"), "must never enter candidate\n")
  const transaction = path.join(data.folder, "candidate with spaces")
  await mkdir(transaction)
  const stage = await stageCandidateSource(data.root, revision, transaction)
  expect(await readFile(path.join(stage, "tracked.txt"), "utf8")).toBe("committed candidate bytes\n")
  expect(await lstat(path.join(stage, "private-untracked.txt")).catch(() => undefined)).toBeUndefined()
  expect(await readFile(tracked, "utf8")).toBe("later working tree changes\n")
  await expect(stageCandidateSource(data.root, revision, transaction)).rejects.toThrow()
  expect(await readFile(path.join(stage, "tracked.txt"), "utf8")).toBe("committed candidate bytes\n")
})
