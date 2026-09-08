// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs"
import { lstat, open, realpath, rename, unlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { requireDisposableLinuxRunner } from "./linux-qualification"
import { sha256File } from "./qualification"

type Shutdown = { applicationExited: boolean; descendantsExited: boolean; runtimeCacheRemoved: boolean }
type Stage = { ino: number; dev: number; size: number; sha256: string }
const failure = () => new Error("APPIMAGE_REPLACEMENT_UNCONFIRMED")

/** Real portable file staging, never a native launch or public PASS. The caller
 * owns anchored public upgrade inputs, actual baseline/recovery/target launches
 * and their verified process shutdown, payload/vault/profile observations. */
export async function prepareAppImageReplacement(input: {
  env: NodeJS.ProcessEnv
  root: string
  runnable: string
  baselineSha256: string
  targetArtifact: string
  targetSha256: string
}) {
  const { root, runnable, baselineSha256, targetArtifact, targetSha256 } = input
  await requireDisposableLinuxRunner(input.env, root)
  if (
    runnable !== join(root, "extractable.AppImage") ||
    !isAbsolute(targetArtifact) ||
    targetArtifact === runnable ||
    ![baselineSha256, targetSha256].every((hash) => /^[a-f0-9]{64}$/.test(hash)) ||
    baselineSha256 === targetSha256
  )
    throw failure()
  const rootOwner = await lstat(root)
  const incoming = join(root, "appimage-upgrade.incoming")
  let phase: "ready" | "writing" | "partial" | "completed" = "ready"
  let partial: Stage | undefined

  async function regular(file: string) {
    const value = await lstat(file)
    if (
      !value.isFile() ||
      value.isSymbolicLink() ||
      value.nlink !== 1 ||
      value.size < 4096 ||
      value.size > 2 * 1024 ** 3
    )
      throw failure()
    return value
  }
  async function preflight(proof: Shutdown) {
    if (proof.applicationExited !== true || proof.descendantsExited !== true || proof.runtimeCacheRemoved !== true)
      throw failure()
    const owner = await lstat(root)
    if (
      !owner.isDirectory() ||
      owner.isSymbolicLink() ||
      owner.dev !== rootOwner.dev ||
      owner.ino !== rootOwner.ino ||
      owner.uid !== process.getuid?.() ||
      (owner.mode & 0o777) !== 0o700 ||
      (await realpath(root)) !== root
    )
      throw failure()
    const executable = await regular(runnable)
    if (
      executable.uid !== process.getuid?.() ||
      (await sha256File(runnable)) !== baselineSha256 ||
      (await sha256File(targetArtifact)) !== targetSha256
    )
      throw failure()
    await regular(targetArtifact)
  }
  async function stageAbsent() {
    const absent = await lstat(incoming).then(
      () => false,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return true
        throw error
      },
    )
    if (!absent) throw failure()
  }
  async function writeStage(partialOnly: boolean) {
    const before = await regular(targetArtifact)
    const source = await open(targetArtifact, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const sourceStat = await source.stat()
      if (sourceStat.ino !== before.ino || sourceStat.dev !== before.dev || sourceStat.size !== before.size)
        throw failure()
      const output = await open(incoming, "wx", 0o700)
      try {
        const amount = partialOnly ? Math.min(1024 * 1024, Math.floor(before.size / 2)) : before.size
        const hash = createHash("sha256")
        const buffer = Buffer.alloc(256 * 1024)
        let offset = 0
        while (offset < amount) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, amount - offset), offset)
          if (!bytesRead) throw failure()
          hash.update(buffer.subarray(0, bytesRead))
          let written = 0
          while (written < bytesRead) {
            const result = await output.write(buffer, written, bytesRead - written, offset + written)
            if (!result.bytesWritten) throw failure()
            written += result.bytesWritten
          }
          offset += bytesRead
        }
        await output.sync()
        const result = await output.stat()
        const after = await source.stat()
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          result.size !== amount
        )
          throw failure()
        const digest = hash.digest("hex")
        if (!partialOnly && digest !== targetSha256) throw failure()
        return { ino: result.ino, dev: result.dev, size: amount, sha256: digest }
      } finally {
        await output.close()
      }
    } finally {
      await source.close()
    }
  }
  async function verifyStage(stage: Stage) {
    const stat = await lstat(incoming)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.dev !== stage.dev ||
      stat.ino !== stage.ino ||
      stat.size !== stage.size ||
      (await sha256File(incoming)) !== stage.sha256
    )
      throw failure()
  }

  return {
    incoming,
    async interrupt(proof: Shutdown) {
      if (phase !== "ready") throw failure()
      await preflight(proof)
      await stageAbsent()
      phase = "writing"
      partial = await writeStage(true)
      await verifyStage(partial)
      await preflight(proof)
      const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      phase = "partial"
      return {
        kind: "appimage-partial-staging-before-atomic-replacement" as const,
        writerClosed: true as const,
        baselinePayloadChanged: false as const,
        targetInstallationComplete: false as const,
        stagedBytes: partial.size,
      }
    },
    async complete(proof: Shutdown) {
      if (phase !== "ready" && phase !== "partial") throw failure()
      await preflight(proof)
      if (phase === "partial") {
        if (!partial) throw failure()
        await verifyStage(partial)
        phase = "writing"
        await unlink(incoming)
      } else {
        await stageAbsent()
        phase = "writing"
      }
      const complete = await writeStage(false)
      await verifyStage(complete)
      await preflight(proof)
      await rename(incoming, runnable)
      const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      if ((await sha256File(runnable)) !== targetSha256) throw failure()
      await stageAbsent()
      phase = "completed"
      return {
        scope: "portable-atomic-replacement",
        targetBytesMatch: true,
        directorySynced: true,
        stagedFileAbsent: true,
      }
    },
  }
}
