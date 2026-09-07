// SPDX-License-Identifier: Apache-2.0
import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from "node:crypto"
import fs from "node:fs"
import { lstat, open, realpath, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export type DiagnosticsContext = {
  runId: string
  runAttempt: number
  sourceRevision: string
  artifactSha256: string
}

export type SealedDiagnosticsResult =
  | { status: "SEALED"; files: number; truncatedFiles: number; bytes: number; sha256: string }
  | { status: "DISABLED"; reason: "NO_PUBLIC_KEY" }
  | {
      status: "FAILED"
      reason:
        | "INVALID_PUBLIC_KEY"
        | "INVALID_CONTEXT"
        | "UNSAFE_INPUT"
        | "NO_DIAGNOSTICS"
        | "OUTPUT_UNAVAILABLE"
        | "SEAL_FAILED"
    }

const limit = 1024 * 1024
const names = ["application.log", "diagnostic.txt"] as const

/**
 * Only direct, fixed-name log files are read. The output contains ciphertext and
 * public identifiers, never raw paths, profiles, attachments or plaintext errors.
 * root and the output parent must already be canonical absolute paths. Callers
 * normalize their owned directories with realpath, including Windows 8.3 aliases.
 * JSON.stringify(envelope.protected) is the exact UTF-8 AES-GCM AAD and RSA OAEP
 * label; a decryptor must also compare its context to independently expected IDs.
 */
export async function sealDiagnostics(input: {
  root: string
  publicKeyPem?: string
  output: string
  context: DiagnosticsContext
}): Promise<SealedDiagnosticsResult> {
  if (input.publicKeyPem === undefined || input.publicKeyPem.trim() === "")
    return { status: "DISABLED", reason: "NO_PUBLIC_KEY" }

  const key = publicKey(input.publicKeyPem)
  if (!key) return { status: "FAILED", reason: "INVALID_PUBLIC_KEY" }
  const context = validatedContext(input.context)
  if (!context) return { status: "FAILED", reason: "INVALID_CONTEXT" }

  try {
    if (!isAbsolute(input.root) || !isAbsolute(input.output)) return { status: "FAILED", reason: "UNSAFE_INPUT" }
    const root = resolve(input.root)
    const parent = resolve(dirname(input.output))
    const output = resolve(input.output)
    if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root || (await realpath(parent)) !== parent)
      return { status: "FAILED", reason: "UNSAFE_INPUT" }
    const distance = relative(root, output)
    if (!distance || (!distance.startsWith(`..${sep}`) && distance !== ".." && !isAbsolute(distance)))
      return { status: "FAILED", reason: "UNSAFE_INPUT" }

    const files = []
    for (const name of names) {
      const file = await readLog(join(root, name), name)
      if (file) files.push(file)
    }
    if (!files.length) return { status: "FAILED", reason: "NO_DIAGNOSTICS" }

    const header = {
      schemaVersion: 1,
      kind: "sealed-desktop-diagnostics",
      contentEncryption: "AES-256-GCM",
      keyEncryption: "RSA-OAEP-SHA256",
      recipientKeySha256: createHash("sha256")
        .update(key.export({ format: "der", type: "spki" }))
        .digest("hex"),
      context,
    }
    const aad = Buffer.from(JSON.stringify(header))
    const secret = randomBytes(32)
    const plaintext = Buffer.from(JSON.stringify({ schemaVersion: 1, files }))
    const iv = randomBytes(12)
    const envelope = (() => {
      try {
        const cipher = createCipheriv("aes-256-gcm", secret, iv, { authTagLength: 16 })
        cipher.setAAD(aad)
        return Buffer.from(
          `${JSON.stringify({
            protected: header,
            wrappedKey: publicEncrypt(
              { key, oaepHash: "sha256", oaepLabel: aad, padding: constants.RSA_PKCS1_OAEP_PADDING },
              secret,
            ).toString("base64"),
            iv: iv.toString("base64"),
            ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
          })}\n`,
        )
      } finally {
        secret.fill(0)
        plaintext.fill(0)
      }
    })()

    // Exclusive creation preserves existing evidence and rejects output symlinks.
    const destination = await open(output, "wx", 0o600).catch(() => undefined)
    if (!destination) return { status: "FAILED", reason: "OUTPUT_UNAVAILABLE" }
    try {
      await destination.writeFile(envelope)
      await destination.sync()
    } catch {
      await destination.close().catch(() => {})
      await unlink(output).catch(() => {})
      return { status: "FAILED", reason: "SEAL_FAILED" }
    }
    await destination.close()
    return {
      status: "SEALED",
      files: files.length,
      truncatedFiles: files.filter((file) => file.truncated).length,
      bytes: envelope.length,
      sha256: createHash("sha256").update(envelope).digest("hex"),
    }
  } catch {
    return { status: "FAILED", reason: "UNSAFE_INPUT" }
  }
}

function publicKey(pem: string) {
  try {
    if (
      pem.length > 16_384 ||
      !/^\s*-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----\s*$/.test(pem)
    )
      return
    const key = createPublicKey({ key: pem, format: "pem", type: "spki" })
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
    if (key.asymmetricKeyType !== "rsa" || bits < 3072 || bits > 16_384) return
    return key
  } catch {
    return
  }
}

function validatedContext(value: DiagnosticsContext) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "artifactSha256,runAttempt,runId,sourceRevision" ||
    typeof value.runId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value.runId) ||
    !Number.isSafeInteger(value.runAttempt) ||
    value.runAttempt < 1 ||
    typeof value.sourceRevision !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.sourceRevision) ||
    typeof value.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.artifactSha256)
  )
    return
  return {
    runId: value.runId,
    runAttempt: value.runAttempt,
    sourceRevision: value.sourceRevision,
    artifactSha256: value.artifactSha256,
  }
}

async function readLog(path: string, name: (typeof names)[number]) {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new Error("Log unavailable")
  })
  if (!before) return
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !Number.isSafeInteger(before.size))
    throw new Error("Unsafe log")
  // Nonblocking open prevents a substituted FIFO from hanging the collector.
  const file = await open(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size !== before.size
    )
      throw new Error("Changed log")
    const buffer = Buffer.alloc(Math.min(limit, stat.size))
    const offset = Math.max(0, stat.size - limit)
    let count = 0
    while (count < buffer.length) {
      const result = await file.read(buffer, count, buffer.length - count, offset + count)
      if (!result.bytesRead) throw new Error("Incomplete log")
      count += result.bytesRead
    }
    const after = await file.stat()
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new Error("Changed log")
    return {
      name,
      sourceBytes: stat.size,
      offsetBytes: offset,
      retainedBytes: buffer.length,
      truncated: offset > 0,
      encoding: "base64",
      data: buffer.toString("base64"),
    }
  } finally {
    await file.close()
  }
}
