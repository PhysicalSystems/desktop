// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import {
  constants,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject,
} from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sealDiagnostics, type DiagnosticsContext } from "./sealed-diagnostics"

// Test-only keys stay in memory; no production key or private PEM is committed.
const pair = generateKeyPairSync("rsa", { modulusLength: 3072 })
const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString()
const context = { runId: "34152440169", runAttempt: 1, sourceRevision: "a".repeat(40), artifactSha256: "b".repeat(64) }
const canary = "TEST-ONLY-CREDENTIAL-CANARY-do-not-publish"

type Envelope = {
  protected: {
    schemaVersion: number
    kind: string
    contentEncryption: string
    keyEncryption: string
    recipientKeySha256: string
    context: DiagnosticsContext
  }
  wrappedKey: string
  iv: string
  ciphertext: string
  tag: string
}

function decrypt(envelope: Envelope, key: KeyObject = pair.privateKey, aad?: Buffer) {
  const header = Buffer.from(JSON.stringify(envelope.protected))
  const secret = privateDecrypt(
    { key, oaepHash: "sha256", oaepLabel: header, padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(envelope.wrappedKey, "base64"),
  )
  const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(envelope.iv, "base64"), { authTagLength: 16 })
  decipher.setAAD(aad ?? header)
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
  const data = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()])
  return JSON.parse(data.toString()) as {
    schemaVersion: number
    files: {
      name: string
      sourceBytes: number
      offsetBytes: number
      retainedBytes: number
      truncated: boolean
      encoding: string
      data: string
    }[]
  }
}

async function fixture() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "sealed-diagnostics-private-")))
  const root = join(temp, "qualification")
  await mkdir(root)
  return { temp, root, output: join(temp, "sealed.json"), publicKeyPem, context }
}

test("seals only approved logs, keeps credentials private and decrypts authenticated bytes", async () => {
  const input = await fixture()
  try {
    await writeFile(join(input.root, "application.log"), `startup\ncredential=${canary}\n${input.root}\n`)
    await writeFile(join(input.root, "diagnostic.txt"), "startup failed\n")
    await mkdir(join(input.root, "profile"))
    await writeFile(join(input.root, "profile", "credentials.json"), "excluded-profile-canary")
    await writeFile(join(input.root, "runtime-attach.json"), "excluded-attachment-canary")
    await writeFile(join(input.root, "camera.png"), "excluded-image-canary")
    const result = await sealDiagnostics(input)
    expect(result.status).toBe("SEALED")
    const raw = await readFile(input.output, "utf8")
    expect(raw).not.toContain(canary)
    expect(raw).not.toContain(input.temp)
    expect(raw).not.toContain("application.log")
    expect(JSON.stringify(result)).not.toContain(input.temp)
    const envelope = JSON.parse(raw) as Envelope
    expect(envelope.protected.context).toEqual(context)
    expect(envelope.protected.contentEncryption).toBe("AES-256-GCM")
    expect(envelope.protected.keyEncryption).toBe("RSA-OAEP-SHA256")
    expect(envelope.protected.recipientKeySha256).toBe(
      createHash("sha256")
        .update(pair.publicKey.export({ format: "der", type: "spki" }))
        .digest("hex"),
    )
    const plaintext = decrypt(envelope)
    expect(plaintext.files.map((file) => file.name)).toEqual(["application.log", "diagnostic.txt"])
    expect(Buffer.from(plaintext.files[0]!.data, "base64").toString()).toContain(canary)
    expect(Buffer.from(plaintext.files[1]!.data, "base64").toString()).toBe("startup failed\n")
    expect(JSON.stringify(plaintext)).not.toContain("excluded-")
    expect(result).toEqual({
      status: "SEALED",
      files: 2,
      truncatedFiles: 0,
      bytes: Buffer.byteLength(raw),
      sha256: createHash("sha256").update(raw).digest("hex"),
    })
    if (process.platform !== "win32") expect((await lstat(input.output)).mode & 0o777).toBe(0o600)
    const second = join(input.temp, "second.json")
    expect((await sealDiagnostics({ ...input, output: second })).status).toBe("SEALED")
    const another = JSON.parse(await readFile(second, "utf8")) as Envelope
    expect(another.iv).not.toBe(envelope.iv)
    expect(another.wrappedKey).not.toBe(envelope.wrappedKey)
    expect(another.ciphertext).not.toBe(envelope.ciphertext)
  } finally {
    await rm(input.temp, { recursive: true, force: true })
  }
})

test("rejects the wrong recipient, changed authenticated context and modified ciphertext", async () => {
  const input = await fixture()
  try {
    await writeFile(join(input.root, "application.log"), canary)
    expect((await sealDiagnostics(input)).status).toBe("SEALED")
    const envelope = JSON.parse(await readFile(input.output, "utf8")) as Envelope
    const wrong = generateKeyPairSync("rsa", { modulusLength: 3072 })
    expect(() => decrypt(envelope, wrong.privateKey)).toThrow()
    expect(() => decrypt(envelope, pair.privateKey, Buffer.from("wrong-aad"))).toThrow()
    const changedContext = structuredClone(envelope)
    changedContext.protected.context.runAttempt = 2
    expect(() => decrypt(changedContext)).toThrow()
    const bytes = Buffer.from(envelope.ciphertext, "base64")
    bytes[0] = bytes[0]! ^ 1
    expect(() => decrypt({ ...envelope, ciphertext: bytes.toString("base64") })).toThrow()
    const tag = Buffer.from(envelope.tag, "base64")
    tag[0] = tag[0]! ^ 1
    expect(() => decrypt({ ...envelope, tag: tag.toString("base64") })).toThrow()
  } finally {
    await rm(input.temp, { recursive: true, force: true })
  }
})

test("retains at most the last MiB per log and marks the exact omitted byte count", async () => {
  const input = await fixture()
  try {
    const size = 1024 * 1024
    const first = Buffer.concat([Buffer.alloc(123, "x"), Buffer.alloc(size, "a")])
    const second = Buffer.concat([Buffer.alloc(987, "y"), Buffer.alloc(size, "b")])
    await writeFile(join(input.root, "application.log"), first)
    await writeFile(join(input.root, "diagnostic.txt"), second)
    const result = await sealDiagnostics(input)
    expect(result.status).toBe("SEALED")
    if (result.status !== "SEALED") throw new Error("Expected sealed fixture")
    expect(result.truncatedFiles).toBe(2)
    expect(result.bytes).toBeLessThan(4 * size)
    const plaintext = decrypt(JSON.parse(await readFile(input.output, "utf8")))
    for (const [index, original] of [first, second].entries()) {
      const file = plaintext.files[index]!
      expect(file.sourceBytes).toBe(original.length)
      expect(file.retainedBytes).toBe(size)
      expect(file.offsetBytes).toBe(original.length - size)
      expect(file.truncated).toBe(true)
      expect(file.encoding).toBe("base64")
      expect(Buffer.from(file.data, "base64").equals(original.subarray(-size))).toBe(true)
    }
  } finally {
    await rm(input.temp, { recursive: true, force: true })
  }
})

test("missing key disables collection, and invalid keys or contexts never create evidence", async () => {
  const input = await fixture()
  try {
    expect(await sealDiagnostics({ ...input, root: "missing-relative-root", publicKeyPem: undefined })).toEqual({
      status: "DISABLED",
      reason: "NO_PUBLIC_KEY",
    })
    expect(await sealDiagnostics({ ...input, publicKeyPem: "  \n" })).toEqual({
      status: "DISABLED",
      reason: "NO_PUBLIC_KEY",
    })
    const weak = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    for (const publicKeyPem of [
      canary,
      weak.publicKey.export({ format: "pem", type: "spki" }).toString(),
      ec.publicKey.export({ format: "pem", type: "spki" }).toString(),
      pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      pair.publicKey.export({ format: "pem", type: "pkcs1" }).toString(),
      input.publicKeyPem + input.publicKeyPem,
    ])
      expect(await sealDiagnostics({ ...input, publicKeyPem })).toEqual({
        status: "FAILED",
        reason: "INVALID_PUBLIC_KEY",
      })
    for (const context of [
      { ...input.context, runId: canary },
      { ...input.context, runAttempt: 0 },
      { ...input.context, runAttempt: 1.1 },
      { ...input.context, sourceRevision: "A".repeat(40) },
      { ...input.context, artifactSha256: canary },
      { ...input.context, rawPath: input.root },
    ])
      expect(await sealDiagnostics({ ...input, context })).toEqual({ status: "FAILED", reason: "INVALID_CONTEXT" })
    expect(await lstat(input.output).catch(() => undefined)).toBeUndefined()
  } finally {
    await rm(input.temp, { recursive: true, force: true })
  }
})

test("missing logs fail safely, a single log is sufficient and existing or internal outputs are preserved", async () => {
  const input = await fixture()
  try {
    expect(await sealDiagnostics(input)).toEqual({ status: "FAILED", reason: "NO_DIAGNOSTICS" })
    expect(await lstat(input.output).catch(() => undefined)).toBeUndefined()
    await writeFile(join(input.root, "diagnostic.txt"), canary)
    expect(await sealDiagnostics({ ...input, output: join(input.root, "sealed.json") })).toEqual({
      status: "FAILED",
      reason: "UNSAFE_INPUT",
    })
    await writeFile(input.output, "existing-evidence")
    expect(await sealDiagnostics(input)).toEqual({ status: "FAILED", reason: "OUTPUT_UNAVAILABLE" })
    expect(await readFile(input.output, "utf8")).toBe("existing-evidence")
    const output = join(input.temp, "single.json")
    expect((await sealDiagnostics({ ...input, output })).status).toBe("SEALED")
    expect(decrypt(JSON.parse(await readFile(output, "utf8"))).files.map((file) => file.name)).toEqual([
      "diagnostic.txt",
    ])
    await mkdir(join(input.root, "application.log"))
    expect(await sealDiagnostics({ ...input, output: join(input.temp, "directory.json") })).toEqual({
      status: "FAILED",
      reason: "UNSAFE_INPUT",
    })
  } finally {
    await rm(input.temp, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "rejects symlink logs, roots and output parents without following them",
  async () => {
    const input = await fixture()
    try {
      const privateFile = join(input.temp, "private-token.txt")
      await writeFile(privateFile, canary)
      await symlink(privateFile, join(input.root, "application.log"))
      expect(await sealDiagnostics(input)).toEqual({ status: "FAILED", reason: "UNSAFE_INPUT" })
      expect(await lstat(input.output).catch(() => undefined)).toBeUndefined()
      await rm(join(input.root, "application.log"))
      await writeFile(join(input.root, "application.log"), "normal log")
      await symlink(input.root, join(input.temp, "root-link"))
      expect(await sealDiagnostics({ ...input, root: join(input.temp, "root-link") })).toEqual({
        status: "FAILED",
        reason: "UNSAFE_INPUT",
      })
      await symlink(input.root, join(input.temp, "parent-link"))
      expect(await sealDiagnostics({ ...input, output: join(input.temp, "parent-link", "sealed.json") })).toEqual({
        status: "FAILED",
        reason: "UNSAFE_INPUT",
      })
      await symlink(privateFile, input.output)
      expect(await sealDiagnostics(input)).toEqual({ status: "FAILED", reason: "OUTPUT_UNAVAILABLE" })
      expect(await readFile(privateFile, "utf8")).toBe(canary)
    } finally {
      await rm(input.temp, { recursive: true, force: true })
    }
  },
)
