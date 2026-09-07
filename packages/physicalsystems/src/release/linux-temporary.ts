// SPDX-License-Identifier: Apache-2.0
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises"
import { posix } from "node:path"
import { requireDisposableLinuxRunner } from "./linux-qualification"

// Electron 42.3.3 creates TMPDIR/scoped_dirXXXXXX/SingletonSocket. Chromium's
// Linux sockaddr_un requires this whole path, including its NUL, to fit 108 bytes.
export function linuxTemporaryPrefix(temporary: string) {
  const prefix = posix.join(temporary, "ps-")
  if (
    temporary === "/" ||
    !posix.isAbsolute(temporary) ||
    posix.normalize(temporary) !== temporary ||
    temporary.includes("\0") ||
    Buffer.byteLength(`${prefix}XXXXXX/scoped_dirXXXXXX/SingletonSocket`) >= 108
  )
    throw new Error("LINUX_QUALIFICATION_TEMP_PATH_INVALID")
  return prefix
}

/** Allocate only on the disposable runner; the app's persistent profile stays unchanged. */
export async function allocateLinuxQualificationTemporary(env: NodeJS.ProcessEnv, root: string) {
  await requireDisposableLinuxRunner(env, root)
  const parent = await realpath(env.RUNNER_TEMP!)
  const path = await mkdtemp(linuxTemporaryPrefix(parent))
  await chmod(path, 0o700)
  const owner = await lstat(path)
  if (
    !owner.isDirectory() ||
    owner.isSymbolicLink() ||
    owner.uid !== process.getuid?.() ||
    (owner.mode & 0o777) !== 0o700
  )
    throw new Error("LINUX_QUALIFICATION_TEMP_OWNERSHIP_INVALID")
  return {
    path,
    environment: Object.freeze({ TMPDIR: path, TEMP: path, TMP: path }),
    async cleanup(proof: { applicationExited: boolean; descendantsExited: boolean }) {
      // Retain even an empty directory when either process boundary is uncertain.
      if (proof.applicationExited !== true || proof.descendantsExited !== true) return "RETAINED" as const
      const current = await lstat(path)
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== owner.dev ||
        current.ino !== owner.ino ||
        current.uid !== owner.uid ||
        (current.mode & 0o777) !== 0o700 ||
        (await realpath(path)) !== path ||
        (await realpath(parent)) !== parent
      )
        throw new Error("LINUX_QUALIFICATION_TEMP_OWNERSHIP_INVALID")
      await rm(path, { recursive: true })
      return "REMOVED" as const
    },
  }
}
