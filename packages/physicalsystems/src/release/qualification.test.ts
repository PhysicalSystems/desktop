// SPDX-License-Identifier: Apache-2.0
import { physicalEnvironment } from "../environment"
import { agentBuildChannel, agentDatabaseName } from "./agent-channel"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, chmod, lstat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import {
  authenticodeResult,
  executableArtifactCopy,
  observePackagedStartup,
  payloadFingerprint,
  qualificationEnvironment,
  qualificationFailureCode,
  qualificationReport,
  requiredQualificationChecks,
  sha256File,
  verifyWindowsVersionInfo,
} from "./qualification"
import type { QualificationFailureCode } from "./qualification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("owned startup exit promptly reports bounded native categories without private stderr", async () => {
  for (const [stderr, expected] of [
    [
      "The SUID sandbox helper binary was found, but is not configured correctly. /private/profile credential-trap",
      "PACKAGED_SANDBOX_INITIALIZATION_FAILED",
    ],
    [
      "Failed to move to new namespace: errno = Operation not permitted credential-trap",
      "PACKAGED_SANDBOX_INITIALIZATION_FAILED",
    ],
    ["error while loading shared libraries: private-library.so credential-trap", "PACKAGED_SHARED_LIBRARY_UNAVAILABLE"],
    ["Missing X server or $DISPLAY credential-trap", "PACKAGED_DISPLAY_UNAVAILABLE"],
    ["unknown failure /private/profile credential-trap", "PACKAGED_APP_EXITED_BEFORE_READY"],
    ["No usable sandbox!" + "x".repeat(17000), "PACKAGED_APP_EXITED_BEFORE_READY"],
  ] as const) {
    const child = spawn(
      process.execPath,
      ["-e", "process.stderr.write(process.argv[1]); process.exitCode = 1", stderr],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    )
    const startup = observePackagedStartup(child)
    await new Promise((resolve) => child.once("close", resolve))
    expect(() => startup.assertRunning()).toThrow(expected)
    try {
      startup.assertRunning()
    } catch (error) {
      expect(String(error)).not.toContain("credential-trap")
      expect(qualificationFailureCode(error)).toBe(expected)
    }
    startup.dispose()
  }
})

test("startup observation handles spawn failure and stops after readiness", async () => {
  const child = spawn(join(tmpdir(), "missing-qualification-executable-does-not-exist"), [], { stdio: "pipe" })
  const startup = observePackagedStartup(child)
  await new Promise((resolve) => child.once("close", resolve))
  expect(() => startup.assertRunning()).toThrow("PACKAGED_APP_SPAWN_FAILED")
  startup.dispose()

  const ready = spawn(process.execPath, ["-e", "process.exitCode = 0"], { stdio: "pipe" })
  const observed = observePackagedStartup(ready)
  observed.assertRunning()
  observed.dispose()
  await new Promise((resolve) => ready.once("close", resolve))
  expect(() => observed.assertRunning()).not.toThrow()
  expect(ready.stderr.listenerCount("data")).toBe(0)
})

test("packaged CDP discovery accepts only the owned exact loopback announcement across stderr chunks", () => {
  const child = new EventEmitter() as ChildProcess
  child.stderr = new PassThrough()
  const startup = observePackagedStartup(child)
  const uuid = "aabbccdd-1122-3344-5566-778899aabbcc"
  for (const endpoint of [
    `ws://192.0.2.1:1234/devtools/browser/${uuid}`,
    `ws://127.0.0.1:1234@evil.example/devtools/browser/${uuid}`,
    `ws://127.0.0.1:65536/devtools/browser/${uuid}`,
    `ws://127.0.0.1:0/devtools/browser/${uuid}`,
    `ws://127.0.0.1:1234/devtools/page/${uuid}`,
    `ws://127.0.0.1:1234/devtools/browser/${uuid}?credential=private-trap`,
  ]) {
    child.stderr.emit("data", `DevTools listening on ${endpoint}\n`)
    expect(startup.debugPort()).toBeUndefined()
  }
  child.stderr.emit("data", "DevTools listening on ws://127.0.")
  expect(startup.debugPort()).toBeUndefined()
  child.stderr.emit("data", `0.1:43210/devtools/browser/${uuid}\r\n`)
  expect(startup.debugPort()).toBe(43210)
  child.stderr.emit("data", "private-trap".repeat(2000))
  expect(startup.debugPort()).toBe(43210)
  startup.dispose()
  expect(startup.debugPort()).toBeUndefined()
  expect(child.stderr.listenerCount("data")).toBe(0)
})

test("startup phase diagnostics accept only complete allowlisted owned stderr markers", () => {
  const child = new EventEmitter() as ChildProcess
  child.stderr = new PassThrough()
  child.stdout = new PassThrough()
  const startup = observePackagedStartup(child)
  child.stdout.emit("data", "PHYSICALSYSTEMS_STARTUP_MAIN_ENTER\n")
  child.stderr.emit("data", "PHYSICALSYSTEMS_STARTUP_PRIVATE_TOKEN\n")
  expect(startup.startupPhase()).toBeUndefined()
  child.stderr.emit("data", "PHYSICALSYSTEMS_STARTUP_CRASH_REPORTER_BEFORE")
  expect(startup.startupPhase()).toBeUndefined()
  child.stderr.emit("data", "\r\n")
  expect(startup.startupPhase()).toBe("CRASH_REPORTER_BEFORE")
  child.stderr.emit("data", "PHYSICALSYSTEMS_STARTUP_OPERATOR_AFTER credential-private-trap\n")
  expect(startup.startupPhase()).toBe("CRASH_REPORTER_BEFORE")
  startup.dispose()
  expect(startup.startupPhase()).toBeUndefined()
})

test("startup timeout classifies a retained native error dialog without exposing private output", () => {
  for (const [output, expected] of [
    ["Error [ERR_MODULE_NOT_FOUND]: private-trap", "PACKAGED_MODULE_INITIALIZATION_FAILED"],
    ["Error: Module did not self-register. private-trap", "PACKAGED_MODULE_INITIALIZATION_FAILED"],
    ["A JavaScript error occurred in the main process private-trap", "PACKAGED_MAIN_PROCESS_EXCEPTION"],
    ["(FiberFailure) Error: private-trap", "PACKAGED_MAIN_PROCESS_EXCEPTION"],
    ["(FiberFailure) Error: OPERATOR_REQUEST_UNCONFIRMED private-trap", "PACKAGED_OPERATOR_STARTUP_FAILED"],
    ["some warning /private/profile private-trap", "PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE"],
  ] as const) {
    for (const stream of ["stderr", "stdout"] as const) {
      const child = new EventEmitter() as ChildProcess
      child.stderr = new PassThrough()
      child.stdout = new PassThrough()
      const startup = observePackagedStartup(child)
      child[stream]!.emit("data", output)
      expect(() => startup.assertRunning()).not.toThrow()
      const code = startup.timeoutCode("PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE")
      expect(code).toBe(expected)
      expect(qualificationFailureCode(new Error(code))).toBe(expected)
      expect(code).not.toContain("private-trap")
      startup.dispose()
      expect(child.stdout.listenerCount("data")).toBe(0)
      expect(child.stderr.listenerCount("data")).toBe(0)
    }
  }
})

test("failure diagnostics preserve only exact authored codes and never private error text", () => {
  const error = new Error("PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE")
  error.stack = "private-stack credential=qualification-credential-trap /private/profile"
  expect(qualificationFailureCode(error)).toBe("PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE")
  expect(qualificationFailureCode(new Error("PACKAGED_SHUTDOWN_DIAGNOSTIC_UNCONFIRMED"))).toBe(
    "PACKAGED_SHUTDOWN_DIAGNOSTIC_UNCONFIRMED",
  )
  for (const unknown of [
    new Error("PACKAGED_SHUTDOWN_DIAGNOSTIC_UNCONFIRMED private-native-output"),
    new Error("PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE credential=qualification-credential-trap"),
    new Error("PACKAGED_NEW_CODE_NOT_REVIEWED"),
    new Error("ENOENT: /private/profile/runtime-attach.json qualification-credential-trap"),
    { message: "PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE", credential: "qualification-credential-trap" },
    "PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE",
    undefined,
  ])
    expect(qualificationFailureCode(unknown)).toBe("QUALIFICATION_UNEXPECTED_ERROR")

  const text = JSON.stringify(
    qualificationReport({
      artifact: "/private/profile/candidate.deb",
      artifactSha256: "a".repeat(64),
      artifactBytes: 17,
      version: "0.1.0-beta.1",
      signature: { status: "NOT_TESTED", trust: "NOT_APPLICABLE" },
      checks: [
        { id: "launch", status: "FAIL", detail: "Launch failed.", failureCode: qualificationFailureCode(error) },
        {
          id: "cleanup",
          status: "FAIL",
          detail: "Cleanup unconfirmed.",
          failureCode: qualificationFailureCode(new Error("/private/profile qualification-credential-trap")),
        },
      ],
    }),
  )
  expect(text).toContain("PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE")
  expect(text).toContain("QUALIFICATION_UNEXPECTED_ERROR")
  expect(text).not.toContain("qualification-credential-trap")
  expect(text).not.toContain("/private/profile")
  expect(text).not.toContain("private-stack")
})

test("receipt generation rejects unknown failure codes and diagnostics attached to passing checks", () => {
  const input = {
    artifact: "candidate.deb",
    artifactSha256: "a".repeat(64),
    artifactBytes: 17,
    version: "0.1.0-beta.1",
    signature: { status: "NOT_TESTED" as const, trust: "NOT_APPLICABLE" },
  }
  expect(() =>
    qualificationReport({
      ...input,
      checks: [
        { id: "launch", status: "PASS", detail: "Recorded", failureCode: "PACKAGED_DEBUG_ENDPOINT_UNAVAILABLE" },
      ],
    }),
  ).toThrow("Invalid qualification failure diagnostic")
  expect(() =>
    qualificationReport({
      ...input,
      checks: [
        { id: "launch", status: "FAIL", detail: "Failed", failureCode: "credential-trap" as QualificationFailureCode },
      ],
    }),
  ).toThrow("Invalid qualification failure diagnostic")
})

test("signature validation requires Windows trust status and a signer identity", () => {
  expect(authenticodeResult({ Status: "NotSigned" })).toEqual({
    status: "BLOCKED",
    trust: "UNSIGNED_INTERNAL_CANDIDATE",
  })
  expect(authenticodeResult({ Status: "Valid", Thumbprint: "A".repeat(40) }).status).toBe("PASS")
  for (const Status of ["HashMismatch", "NotTrusted", "UnknownError", 0])
    expect(authenticodeResult({ Status, Thumbprint: "A".repeat(40) }).status).toBe("FAIL")
  expect(authenticodeResult({ Status: "Valid" }).status).toBe("FAIL")
  expect(authenticodeResult({ Status: "Valid", Thumbprint: "looks signed" }).status).toBe("FAIL")
})

test.skipIf(process.platform === "win32")(
  "downloaded nonexecutable AppImage bytes get an owned executable copy without mutating the original",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ps-appimage-copy-"))
    roots.push(root)
    const source = join(root, "downloaded.AppImage")
    const destination = join(root, "owned.AppImage")
    await writeFile(source, "fixture AppImage payload bytes")
    await chmod(source, 0o600)
    const digest = await sha256File(source)
    await executableArtifactCopy(source, destination, digest)
    expect((await lstat(source)).mode & 0o777).toBe(0o600)
    expect((await lstat(destination)).mode & 0o777).toBe(0o700)
    expect(await sha256File(source)).toBe(digest)
    expect(await sha256File(destination)).toBe(digest)
    await expect(executableArtifactCopy(source, destination, digest)).rejects.toThrow()
    await writeFile(source, "changed after inventory")
    await expect(executableArtifactCopy(source, join(root, "wrong.AppImage"), digest)).rejects.toThrow(
      "ARTIFACT_CHANGED",
    )
  },
)

test("Windows PE metadata must carry candidate identity and exact prerelease version", () => {
  const info = { ProductName: "Physical Systems Candidate", FileVersion: "0.1.0-beta.1", ProductVersion: "0.1.0.0" }
  expect(verifyWindowsVersionInfo(info, "0.1.0-beta.1")).toEqual({
    productName: "Physical Systems Candidate",
    fileVersion: "0.1.0-beta.1",
    productVersion: "0.1.0.0",
  })
  for (const invalid of [
    { ...info, ProductName: "Electron" },
    { ...info, FileVersion: "42.3.3" },
    { ...info, FileVersion: "0.1.0-beta.2" },
    { ...info, ProductVersion: "0.1.0.31" },
  ])
    expect(() => verifyWindowsVersionInfo(invalid, "0.1.0-beta.1")).toThrow("VERSION_MISMATCH")
})

test("qualification receipt changes if an unpacked native resource changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps-payload-"))
  roots.push(root)
  await mkdir(join(root, "resources", "app.asar.unpacked"), { recursive: true })
  await writeFile(join(root, "app"), "executable")
  await writeFile(join(root, "resources", "app.asar"), "archive")
  await writeFile(join(root, "resources", "app.asar.unpacked", "native.node"), "first")
  const before = await payloadFingerprint(join(root, "app"))
  await writeFile(join(root, "resources", "app.asar.unpacked", "native.node"), "second")
  const after = await payloadFingerprint(join(root, "app"))
  expect(after.sha256).not.toBe(before.sha256)
  expect(after.executableSha256).toBe(before.executableSha256)
  expect(after.entries).toHaveLength(3)
})

test.skipIf(process.platform === "win32")(
  "qualification rejects resource symlinks outside its extracted payload",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ps-payload-"))
    roots.push(root)
    await mkdir(join(root, "resources"))
    await writeFile(join(root, "app"), "executable")
    await symlink(join(root, "app"), join(root, "resources", "external"))
    await expect(payloadFingerprint(join(root, "app"))).rejects.toThrow("QUALIFICATION_PAYLOAD_SYMLINK")
  },
)

test("packaged app gets no installed toolchain, provider credentials or ambient configuration", () => {
  const env = qualificationEnvironment(
    {
      PATH: "/opt/bun:/usr/bin",
      HOME: "/real-home",
      OPENAI_API_KEY: "secret",
      GH_TOKEN: "secret",
      NODE_OPTIONS: "--require=ambient",
      PHYSICALSYSTEMS_ALLOW_DEVICES: "1",
      PHYSICALSYSTEMS_QUALIFICATION_TRACE: "credential-private-trap",
      OPENCODE_CONFIG: "/real/config",
      OPENCODE_DISABLE_CHANNEL_DB: "credential-private-trap",
      OPENCODE_DB: "/private/database",
      DISPLAY: ":44",
    },
    "/owned/profile",
    "linux",
  )
  expect(env.PATH).toBe(join("/owned/profile", "empty-path"))
  expect(env.HOME).toBe("/owned/profile")
  expect(env.PHYSICALSYSTEMS_ALLOW_DEVICES).toBe("0")
  expect(env.PHYSICALSYSTEMS_QUALIFICATION_TRACE).toBe("1")
  expect(env.OPENCODE_DISABLE_CHANNEL_DB).toBeUndefined()
  const actualSidecar = physicalEnvironment(env, "/owned/profile")
  expect(actualSidecar.OPENCODE_DISABLE_CHANNEL_DB).toBeUndefined()
  expect(actualSidecar.OPENCODE_DB).toBeUndefined()
  expect(agentBuildChannel).toBe("dev")
  expect(agentDatabaseName).toBe("opencode-dev.db")
  expect(env.OPENCODE_DB).toBeUndefined()
  expect(JSON.stringify(env)).not.toContain("credential-private-trap")
  expect(env.DISPLAY).toBe(":44")
  for (const key of ["OPENAI_API_KEY", "GH_TOKEN", "NODE_OPTIONS", "OPENCODE_CONFIG"]) expect(env[key]).toBeUndefined()
})

test("archive-only checks cannot be mistaken for packaged application qualification", () => {
  const report = qualificationReport({
    artifact: "/private/profile/candidate.deb",
    artifactSha256: "a".repeat(64),
    artifactBytes: 17,
    version: "0.1.0-preview.1",
    signature: { status: "NOT_TESTED", trust: "NOT_APPLICABLE" },
    checks: [{ id: "artifact-integrity", status: "PASS", detail: "Digest recorded" }],
  })
  expect(report.result).toBe("NOT_TESTED")
  expect(report.publicDistribution.status).toBe("BLOCKED")
  expect(report.artifact.name).toBe("candidate.deb")
  expect(JSON.stringify(report)).not.toContain("/private/profile")
})

test("an omitted, failed or untested mandatory journey prevents a PASS receipt", () => {
  const checks = requiredQualificationChecks.map((id) => ({ id, status: "PASS" as const, detail: "Recorded" }))
  const input = {
    artifact: "candidate.deb",
    artifactSha256: "a".repeat(64),
    artifactBytes: 17,
    version: "0.1.0-preview.1",
    signature: { status: "NOT_TESTED" as const, trust: "NOT_APPLICABLE" },
  }
  expect(qualificationReport({ ...input, checks }).result).toBe("PASS")
  for (const id of requiredQualificationChecks) {
    expect(qualificationReport({ ...input, checks: checks.filter((check) => check.id !== id) }).result).toBe(
      "NOT_TESTED",
    )
    expect(
      qualificationReport({
        ...input,
        checks: checks.map((check) => (check.id === id ? { ...check, status: "FAIL" } : check)),
      }).result,
    ).toBe("FAIL")
  }
})

test.skipIf(process.platform !== "linux")(
  "the actual inspection CLI rejects a malformed package and emits only a bounded failure receipt",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ps-package-cli-"))
    roots.push(root)
    const artifact = join(root, "candidate.deb")
    const output = join(root, "receipt.json")
    await writeFile(artifact, "not a Debian archive")
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../test/packaged-smoke.mjs", import.meta.url)),
        "--artifact",
        artifact,
        "--evidence",
        root,
        "--report",
        output,
        "--version",
        "0.1.0-beta.1",
        "--inspection-only",
      ],
      { stdio: "ignore", env: { ...process.env, OPENAI_API_KEY: "qualification-credential-trap" } },
    )
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error("Inspection fixture timed out"))
      }, 5000)
      child.once("exit", (code) => {
        clearTimeout(timer)
        resolve(code)
      })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    expect(code).toBe(1)
    const text = await readFile(output, "utf8")
    const report = JSON.parse(text)
    expect(report.result).toBe("FAIL")
    expect(report.checks.find((check: { id: string }) => check.id === "launch").status).toBe("NOT_TESTED")
    expect(report.checks.find((check: { id: string }) => check.id === "payload-integrity").status).toBe("FAIL")
    expect(report.checks.find((check: { id: string }) => check.id === "payload-integrity").failureCode).toBe(
      "QUALIFICATION_COMMAND_FAILED",
    )
    expect(text).not.toContain(root)
    expect(text).not.toContain("qualification-credential-trap")
  },
)
