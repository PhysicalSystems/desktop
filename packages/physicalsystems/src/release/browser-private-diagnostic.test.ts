// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBrowserPrivateDiagnostic } from "./browser-private-diagnostic"
import { pendingBrowserDiagnostic } from "./browser-diagnostic"
import { isDiagnosticsPublicKey } from "./sealed-diagnostics"

const pair = generateKeyPairSync("rsa", { modulusLength: 3072 })
const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
const context = { sourceRevision: "a".repeat(40), runId: "123", runAttempt: 1, platform: "windows-x64" as const }
const record = {
  executable: "C:\\PRIVATE-CREDENTIAL-CANARY\\unknown.exe",
  pid: 321,
  parent: 123,
  parentOwned: true,
  sameSid: true,
  sameSession: true,
  validBirth: true,
  exactProfile: false,
}
const directories: string[] = []
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "private-browser-encryption-")))
  directories.push(temporary)
  const outputDirectory = join(temporary, "encrypted")
  await mkdir(outputDirectory)
  const receipt = Buffer.from(JSON.stringify(pendingBrowserDiagnostic(context, "windows-os-loopback"), null, 2) + "\n")
  return { temporary, outputDirectory, receipt }
}
function decrypt(raw: string) {
  const envelope = JSON.parse(raw)
  const aad = Buffer.from(JSON.stringify(envelope.protected))
  const key = privateDecrypt(
    { key: pair.privateKey, oaepHash: "sha256", oaepLabel: aad, padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(envelope.wrappedKey, "base64"),
  )
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"))
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
  const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()])
  const payload = JSON.parse(bytes.toString())
  expect(payload.files).toHaveLength(1)
  expect(payload.files[0].name).toBe("diagnostic.txt")
  return { envelope, private: JSON.parse(Buffer.from(payload.files[0].data, "base64").toString()) }
}

test("no key provides no collection capability; invalid recipients fail before collecting values", () => {
  expect(createBrowserPrivateDiagnostic({ context })).toBeUndefined()
  expect(createBrowserPrivateDiagnostic({ context, publicKeyPem: " \n" })).toBeUndefined()
  expect(isDiagnosticsPublicKey(publicKeyPem)).toBe(true)
  const weak = generateKeyPairSync("rsa", { modulusLength: 2048 })
  for (const invalid of [
    "PRIVATE-CANARY",
    weak.publicKey.export({ type: "spki", format: "pem" }).toString(),
    pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem + publicKeyPem,
  ]) {
    expect(isDiagnosticsPublicKey(invalid)).toBe(false)
    expect(() => createBrowserPrivateDiagnostic({ context, publicKeyPem: invalid })).toThrow(
      "BROWSER_DIAGNOSTIC_PRIVATE_CONTEXT_UNCONFIRMED",
    )
  }
})

test("private executable snapshot is sealed to exact receipt bytes with no plaintext uploaded or retained", async () => {
  const f = await fixture()
  const collector = createBrowserPrivateDiagnostic({ context, publicKeyPem })!
  const mutable = { ...record }
  collector.unknownExecutableSink([mutable])
  mutable.executable = "C:\\MUST-NOT-REPLACE\\changed.exe"
  collector.unknownExecutableSink([{ ...record, executable: "C:\\MUST-NOT-REPLACE\\later.exe" }])
  const result = await collector.seal(f)
  expect(result.status).toBe("SEALED")
  const digest = createHash("sha256").update(f.receipt).digest("hex")
  expect(await readdir(f.outputDirectory)).toEqual([`${digest}.sealed.json`])
  expect(await readdir(f.temporary)).toEqual(["encrypted"])
  const raw = await readFile(join(f.outputDirectory, `${digest}.sealed.json`), "utf8")
  expect(raw).not.toContain("PRIVATE-CREDENTIAL-CANARY")
  expect(raw).not.toContain("unknown.exe")
  expect(f.receipt.toString()).not.toContain(record.executable)
  expect(f.receipt.toString()).not.toContain('"pid":321')
  expect(JSON.stringify(result)).not.toContain(f.temporary)
  const opened = decrypt(raw)
  expect(opened.envelope.protected.context).toEqual({
    runId: context.runId,
    runAttempt: 1,
    sourceRevision: context.sourceRevision,
    artifactSha256: digest,
  })
  expect(opened.private).toMatchObject({
    kind: "private-windows-unknown-executables",
    binding: "sanitized-browser-diagnostic-receipt",
    receiptSha256: digest,
    processes: [record],
  })
  expect(Object.keys(opened.private.processes[0]).sort()).toEqual(Object.keys(record).sort())
  expect(JSON.stringify(opened.private)).not.toContain("MUST-NOT-REPLACE")
  expect(await collector.seal(f)).toEqual(result)
  const tampered = JSON.parse(raw)
  tampered.protected.context.runAttempt = 2
  expect(() => decrypt(JSON.stringify(tampered))).toThrow()
})

test("missing snapshot writes nothing; extra fields, excessive snapshots and malformed values are rejected privately", async () => {
  const f = await fixture()
  const absent = createBrowserPrivateDiagnostic({ context, publicKeyPem })!
  expect(await absent.seal(f)).toEqual({ status: "NOT_COLLECTED", reason: "NO_UNKNOWN_EXECUTABLE" })
  let lateReads = 0
  absent.unknownExecutableSink([
    {
      ...record,
      get executable() {
        lateReads++
        return record.executable
      },
    },
  ])
  expect(lateReads).toBe(0)
  expect(await absent.seal(f)).toEqual({ status: "NOT_COLLECTED", reason: "NO_UNKNOWN_EXECUTABLE" })
  for (const value of [
    [{ ...record, argv: ["PRIVATE-ARGV"] }],
    Array.from({ length: 9 }, () => record),
    [{ ...record, executable: "https://private.example/" }],
    [{ ...record, pid: 0 }],
    [{ ...record, sameSid: "PRIVATE-SID" }],
    [{ ...record, executable: "C:\\x\nPRIVATE" }],
  ]) {
    const collector = createBrowserPrivateDiagnostic({ context, publicKeyPem })!
    collector.unknownExecutableSink(value as never)
    expect(await collector.seal(f)).toEqual({ status: "FAILED", reason: "INVALID_SNAPSHOT" })
  }
  expect(await readdir(f.outputDirectory)).toEqual([])
  expect(await readdir(f.temporary)).toEqual(["encrypted"])
})

test("receipt mismatch cannot seal a snapshot under a different source/run or claim product qualification", async () => {
  const f = await fixture()
  for (const changed of [
    { runId: "124" },
    { runAttempt: 2 },
    { sourceRevision: "b".repeat(40) },
    { mode: "acquisition" },
    { qualification: true },
    { productOpener: "PASS" },
  ]) {
    const collector = createBrowserPrivateDiagnostic({ context, publicKeyPem })!
    collector.unknownExecutableSink([record])
    const receipt = Buffer.from(JSON.stringify({ ...JSON.parse(f.receipt.toString()), ...changed }))
    expect(await collector.seal({ ...f, receipt })).toEqual({ status: "FAILED", reason: "INVALID_RECEIPT" })
  }
  expect(await readdir(f.outputDirectory)).toEqual([])
  expect(await readdir(f.temporary)).toEqual(["encrypted"])
})

test("unavailable ciphertext destination still erases the exclusive plaintext staging directory", async () => {
  const f = await fixture()
  const collector = createBrowserPrivateDiagnostic({ context, publicKeyPem })!
  collector.unknownExecutableSink([record])
  const digest = createHash("sha256").update(f.receipt).digest("hex")
  await mkdir(join(f.outputDirectory, `${digest}.sealed.json`))
  const result = await collector.seal(f)
  expect(result).toEqual({ status: "FAILED", reason: "OUTPUT_UNAVAILABLE" })
  expect(await readdir(f.temporary)).toEqual(["encrypted"])
})
