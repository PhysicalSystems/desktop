// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs"
import { mkdir, rename, unlink, lstat, open } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"

export type DesktopAttachment = { schemaVersion: 1; url: string; username: "opencode"; password: string; pid: number; directory?: string; sessionId?: string }
export async function saveAttachment(file: string, value: DesktopAttachment) {
  if (!isAbsolute(file)) throw new Error("INVALID_DESKTOP_ATTACHMENT_PATH")
  const content = JSON.stringify(validate(value))
  if (Buffer.byteLength(content) > 16384) throw new Error("INVALID_DESKTOP_ATTACHMENT")
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const parent = await lstat(dirname(file))
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("INVALID_DESKTOP_ATTACHMENT_PATH")
  const temporary = file + "." + randomUUID()
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    await rename(temporary, file)
  } finally {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}
export async function readAttachment(file: string): Promise<DesktopAttachment> {
  if (!isAbsolute(file)) throw new Error("INVALID_DESKTOP_ATTACHMENT_PATH")
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("INVALID_DESKTOP_ATTACHMENT")
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const value = await (async () => {
    const before = await handle.stat()
    if (!before.isFile() || before.size > 16384 || (process.platform !== "win32" && (before.mode & 0o077)) || (process.getuid && before.uid !== process.getuid())) throw new Error("INVALID_DESKTOP_ATTACHMENT")
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("DESKTOP_ATTACHMENT_CHANGED")
    return validate(JSON.parse(bytes.subarray(0, offset).toString("utf8")))
  })().finally(() => handle.close())
  try { process.kill(value.pid, 0) } catch { throw new Error("DESKTOP_ATTACHMENT_PROCESS_UNAVAILABLE") }
  return value
}

function validate(value: unknown): DesktopAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_DESKTOP_ATTACHMENT")
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !["schemaVersion", "url", "username", "password", "pid", "directory", "sessionId"].includes(key))) throw new Error("INVALID_DESKTOP_ATTACHMENT")
  const url = typeof record.url === "string" ? URL.parse(record.url) : undefined
  if (record.schemaVersion !== 1 || !url || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1 || url.origin !== record.url || record.username !== "opencode" || typeof record.password !== "string" || record.password.length < 32 || record.password.length > 512 || /\s/.test(record.password) || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0) throw new Error("INVALID_DESKTOP_ATTACHMENT")
  if (record.directory !== undefined && (typeof record.directory !== "string" || !isAbsolute(record.directory) || record.directory.length > 4096 || record.directory.includes("\0"))) throw new Error("INVALID_DESKTOP_ATTACHMENT")
  if (record.sessionId !== undefined && (typeof record.sessionId !== "string" || !/^ses_[a-zA-Z0-9_-]{1,252}$/.test(record.sessionId) || !record.directory)) throw new Error("INVALID_DESKTOP_ATTACHMENT")
  return record as DesktopAttachment
}
