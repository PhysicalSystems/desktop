import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import type { Stats } from "node:fs"
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { compareVersion } from "../../../physicalsystems/src/release/inputs"

export type PreviewUpdateAsset = { name: string; bytes: number; sha256: string; url: string }
type Fetcher = (url: string, options: RequestInit) => Promise<Response>
const failures = new Set([
  "PREVIEW_UPDATE_ASSET_INVALID",
  "PREVIEW_UPDATE_CACHE_UNSAFE",
  "PREVIEW_UPDATE_DOWNLOAD_FAILED",
  "PREVIEW_UPDATE_REDIRECT_INVALID",
  "PREVIEW_UPDATE_SIZE_MISMATCH",
  "PREVIEW_UPDATE_HASH_MISMATCH",
  "PREVIEW_UPDATE_FILE_CHANGED",
  "PREVIEW_UPDATE_FILE_UNSAFE",
])

function asset(input: PreviewUpdateAsset): PreviewUpdateAsset {
  const match =
    typeof input?.name === "string" &&
    /^physical-systems-desktop-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.[1-9]\d*)?)-(?:windows-x64\.exe|linux-x64\.deb|linux-x64\.AppImage)$/.exec(
      input.name,
    )
  if (
    !match ||
    input.name.length > 180 ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > 2 * 1024 ** 3 ||
    typeof input.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    input.url !==
      `https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v${match[1]}/${encodeURIComponent(input.name)}`
  )
    throw new Error("PREVIEW_UPDATE_ASSET_INVALID")
  try {
    if (compareVersion(match[1]!, "0.1.0-beta.1") < 0) throw new Error()
  } catch {
    throw new Error("PREVIEW_UPDATE_ASSET_INVALID")
  }
  return { name: input.name, bytes: input.bytes, sha256: input.sha256, url: input.url }
}

/** Reads the actual bytes again immediately before installer handoff. Persisted
 * ready metadata, a filename and a previous successful hash grant no authority.
 */
export async function reverifyPreviewUpdate(file: string, expectedAsset: PreviewUpdateAsset): Promise<void> {
  const expected = asset(expectedAsset)
  let handle: FileHandle | undefined
  try {
    if (!isAbsolute(file) || resolve(file) !== file) throw new Error("PREVIEW_UPDATE_FILE_UNSAFE")
    const before = await lstat(file)
    if (!ownedRegular(before)) throw new Error("PREVIEW_UPDATE_FILE_UNSAFE")
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("PREVIEW_UPDATE_FILE_CHANGED")
    if (opened.size !== expected.bytes) throw new Error("PREVIEW_UPDATE_SIZE_MISMATCH")
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(1024 * 1024)
    let bytes = 0
    for (;;) {
      const chunk = await handle.read(buffer, 0, buffer.length, null)
      if (!chunk.bytesRead) break
      bytes += chunk.bytesRead
      if (bytes > expected.bytes) throw new Error("PREVIEW_UPDATE_SIZE_MISMATCH")
      hash.update(buffer.subarray(0, chunk.bytesRead))
    }
    const after = await handle.stat()
    const current = await lstat(file)
    if (
      !ownedRegular(current) ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== opened.size ||
      current.mtimeMs !== opened.mtimeMs ||
      current.ctimeMs !== opened.ctimeMs ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error("PREVIEW_UPDATE_FILE_CHANGED")
    if (bytes !== expected.bytes) throw new Error("PREVIEW_UPDATE_SIZE_MISMATCH")
    if (hash.digest("hex") !== expected.sha256) throw new Error("PREVIEW_UPDATE_HASH_MISMATCH")
  } catch (error) {
    throw sanitized(error, "PREVIEW_UPDATE_FILE_UNSAFE")
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Main-process download only: no credentials, shell, installer or app lifecycle.
 * The caller supplies a reviewed discovery result and its own private cache path.
 */
export async function downloadPreviewUpdate(input: {
  asset: PreviewUpdateAsset
  directory: string
  fetch?: Fetcher
  onProgress?: (percent: number) => void
}): Promise<string> {
  const expected = asset(input.asset)
  let partial: string | undefined
  let handle: FileHandle | undefined
  const progress = (percent: number) => {
    try {
      input.onProgress?.(percent)
    } catch {
      // Presentation callbacks cannot change file verification or cleanup.
    }
  }
  try {
    if (!isAbsolute(input.directory) || resolve(input.directory) !== input.directory)
      throw new Error("PREVIEW_UPDATE_CACHE_UNSAFE")
    await mkdir(input.directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(input.directory)
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.platform !== "win32" && ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()))
    )
      throw new Error("PREVIEW_UPDATE_CACHE_UNSAFE")
    const root = await realpath(input.directory)
    const file = join(root, expected.name)
    const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing) {
      try {
        await reverifyPreviewUpdate(file, expected)
        progress(100)
        return file
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !["PREVIEW_UPDATE_SIZE_MISMATCH", "PREVIEW_UPDATE_HASH_MISMATCH"].includes(error.message)
        )
          throw error
        const current = await lstat(file)
        if (
          !ownedRegular(existing) ||
          !ownedRegular(current) ||
          current.dev !== existing.dev ||
          current.ino !== existing.ino ||
          current.size !== existing.size ||
          current.mtimeMs !== existing.mtimeMs ||
          current.ctimeMs !== existing.ctimeMs
        )
          throw new Error("PREVIEW_UPDATE_FILE_CHANGED")
        // A previous failed/tampered download cannot permanently block Retry.
        // Only this unchanged private regular cache entry is eligible for removal.
        await unlink(file)
      }
    }
    partial = join(root, `${expected.name}.${randomUUID()}.partial`)
    handle = await open(partial, "wx", 0o600)
    const request = input.fetch ?? fetch
    const signal = AbortSignal.timeout(5 * 60_000)
    let url = expected.url
    const hash = createHash("sha256")
    let bytes = 0
    progress(0)
    for (let redirects = 0; ; redirects++) {
      const response = await request(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal,
        headers: { Accept: "application/octet-stream" },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => {})
        const next = URL.parse(response.headers.get("location") ?? "")
        if (
          redirects >= 3 ||
          !next ||
          next.protocol !== "https:" ||
          next.port ||
          next.username ||
          next.password ||
          next.hash ||
          !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(next.hostname)
        )
          throw new Error("PREVIEW_UPDATE_REDIRECT_INVALID")
        url = next.href
        continue
      }
      if (!response.ok || response.redirected || !response.body || (response.url && response.url !== url)) {
        await response.body?.cancel().catch(() => {})
        throw new Error("PREVIEW_UPDATE_DOWNLOAD_FAILED")
      }
      const length = response.headers.get("content-length")
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected.bytes)) {
        await response.body.cancel().catch(() => {})
        throw new Error("PREVIEW_UPDATE_SIZE_MISMATCH")
      }
      const reader = response.body.getReader()
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > expected.bytes) throw new Error("PREVIEW_UPDATE_SIZE_MISMATCH")
          hash.update(chunk.value)
          let offset = 0
          while (offset < chunk.value.byteLength) {
            const result = await handle.write(chunk.value, offset, chunk.value.byteLength - offset, null)
            if (!result.bytesWritten) throw new Error("PREVIEW_UPDATE_DOWNLOAD_FAILED")
            offset += result.bytesWritten
          }
          progress((bytes / expected.bytes) * 100)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      break
    }
    if (bytes !== expected.bytes) throw new Error("PREVIEW_UPDATE_SIZE_MISMATCH")
    if (hash.digest("hex") !== expected.sha256) throw new Error("PREVIEW_UPDATE_HASH_MISMATCH")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(partial, file)
    partial = undefined
    await reverifyPreviewUpdate(file, expected)
    progress(100)
    return file
  } catch (error) {
    throw sanitized(error, "PREVIEW_UPDATE_DOWNLOAD_FAILED")
  } finally {
    await handle?.close().catch(() => {})
    if (partial) await unlink(partial).catch(() => {})
  }
}

function sanitized(error: unknown, fallback: string) {
  return new Error(error instanceof Error && failures.has(error.message) ? error.message : fallback)
}

function ownedRegular(stat: Stats) {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    (process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.()))
  )
}
