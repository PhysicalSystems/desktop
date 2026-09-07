// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module"
import { posix, win32 } from "node:path"

type Extractor = { extractFile: (archive: string, member: string) => Buffer }

/** Logical package paths use '/', but the pinned ASAR reader walks directories
 * using the host path separator. Normalize at this API boundary on Windows.
 */
export function packagedArchiveReader(asar: Extractor, archive: string, platform = process.platform) {
  const read = (member: string) => {
    if (
      !member ||
      member.includes("\\") ||
      member.includes("\0") ||
      member.split("/").some((part) => !part || part === "." || part === "..") ||
      /^[A-Za-z]:/.test(member)
    )
      throw new Error("PACKAGED_ARCHIVE_MEMBER_INVALID")
    const native = (platform === "win32" ? win32 : posix).join(...member.split("/"))
    const bytes = (() => {
      try {
        return asar.extractFile(archive, native)
      } catch {
        throw new Error("PACKAGED_RUNTIME_READ_FAILED")
      }
    })()
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("PACKAGED_RUNTIME_FILE_EMPTY")
    return bytes
  }
  return {
    read,
    json(member: string) {
      const bytes = read(member)
      try {
        const data = JSON.parse(bytes.toString("utf8")) as unknown
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("PACKAGED_RUNTIME_JSON_INVALID")
        return data as Record<string, unknown>
      } catch {
        throw new Error("PACKAGED_RUNTIME_JSON_INVALID")
      }
    },
  }
}

export function openPackagedArchive(desktopManifest: string, archive: string) {
  const asar = (() => {
    try {
      const desktopRequire = createRequire(desktopManifest)
      const builderRequire = createRequire(desktopRequire.resolve("electron-builder/package.json"))
      const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"))
      return appBuilderRequire("@electron/asar") as Extractor
    } catch {
      throw new Error("PACKAGED_ARCHIVE_DEPENDENCY_UNAVAILABLE")
    }
  })()
  return packagedArchiveReader(asar, archive)
}
