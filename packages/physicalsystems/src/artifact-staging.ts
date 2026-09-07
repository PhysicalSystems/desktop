// SPDX-License-Identifier: Apache-2.0
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

/** Build in an empty sibling tree; never inventory or publish stale output. */
export async function replaceArtifactDirectory<T>(
  output: string,
  build: (staging: string) => Promise<T>,
  move: typeof rename = rename,
): Promise<T> {
  await requireDirectory(output)
  await mkdir(dirname(output), { recursive: true })
  const transaction = await mkdtemp(join(dirname(output), `.${basename(output)}-build-`))
  const staging = join(transaction, "next")
  const previous = join(transaction, "previous")
  let preserve = false
  try {
    await mkdir(staging)
    const result = await build(staging)
    const exists = await requireDirectory(output)
    if (exists) await move(output, previous)
    try {
      await move(staging, output)
    } catch (error) {
      if (exists) {
        await move(previous, output).catch((rollback) => {
          preserve = true
          throw new AggregateError([error, rollback], `Artifact replacement failed; recover the previous directory from ${previous}`)
        })
      }
      throw error
    }
    return result
  } finally {
    if (!preserve) await rm(transaction, { recursive: true, force: true })
  }
}

async function requireDirectory(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Artifact output must be a real directory: ${path}`)
  return Boolean(info)
}
