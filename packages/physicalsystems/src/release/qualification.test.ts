// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, chmod, lstat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  authenticodeResult,
  executableArtifactCopy,
  payloadFingerprint,
  qualificationEnvironment,
  qualificationReport,
  requiredQualificationChecks,
  sha256File,
  verifyWindowsVersionInfo,
} from "./qualification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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
      OPENCODE_CONFIG: "/real/config",
      DISPLAY: ":44",
    },
    "/owned/profile",
    "linux",
  )
  expect(env.PATH).toBe(join("/owned/profile", "empty-path"))
  expect(env.HOME).toBe("/owned/profile")
  expect(env.PHYSICALSYSTEMS_ALLOW_DEVICES).toBe("0")
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
    expect(text).not.toContain(root)
    expect(text).not.toContain("qualification-credential-trap")
  },
)
