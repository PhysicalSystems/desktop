// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, sep } from "node:path"
import { desktopIdentity } from "./identity"
import { requireDisposableLinuxRunner } from "./linux-qualification"
import { payloadFingerprint } from "./qualification"

async function absent(file: string) {
  return lstat(file).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return true
      throw error
    },
  )
}

/** effcebc is the AppImageKit runtime shipped by pinned builder toolset 0.0.0.
 * Its extract-and-run directory is TMPDIR/appimage_extracted_<whole-file MD5>.
 * MD5 determines that runtime's path only; SHA-256 remains the artifact anchor. */
export async function appImageRuntimeDigests(artifact: string, expectedSha256: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("APPIMAGE_RUNTIME_ARTIFACT_CHANGED")
  const before = await lstat(artifact)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size < 128 ||
    before.size > 2 * 1024 ** 3
  )
    throw new Error("APPIMAGE_RUNTIME_ARTIFACT_CHANGED")
  const file = await open(artifact, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size)
      throw new Error("APPIMAGE_RUNTIME_ARTIFACT_CHANGED")
    const sha256 = createHash("sha256")
    const md5 = createHash("md5")
    const chunk = Buffer.alloc(256 * 1024)
    let offset = 0
    while (offset < stat.size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, stat.size - offset), offset)
      if (!bytesRead) throw new Error("APPIMAGE_RUNTIME_ARTIFACT_CHANGED")
      const bytes = chunk.subarray(0, bytesRead)
      if (
        offset === 0 &&
        (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
          !bytes.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02])) ||
          !bytes.includes(Buffer.from("appimage-version\0effcebc\0")) ||
          !bytes.includes(Buffer.from("--appimage-extract-and-run\0")) ||
          !bytes.includes(Buffer.from("/appimage_extracted_\0")))
      )
        throw new Error("APPIMAGE_RUNTIME_UNSUPPORTED")
      sha256.update(bytes)
      md5.update(bytes)
      offset += bytesRead
    }
    const after = await file.stat()
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      sha256.digest("hex") !== expectedSha256
    )
      throw new Error("APPIMAGE_RUNTIME_ARTIFACT_CHANGED")
    return { md5: md5.digest("hex"), sha256: expectedSha256 }
  } finally {
    await file.close()
  }
}

export async function prepareAppImageRuntime(input: {
  env: NodeJS.ProcessEnv
  root: string
  temporary: string
  artifact: string
  artifactSha256: string
  kind: "candidate" | "public"
}) {
  await requireDisposableLinuxRunner(input.env, input.root)
  if (!["candidate", "public"].includes(input.kind)) throw new Error("APPIMAGE_RUNTIME_PATH_INVALID")
  const temporary = await realpath(input.temporary)
  const runner = await realpath(input.env.RUNNER_TEMP!)
  const stat = await lstat(temporary)
  if (
    temporary !== input.temporary ||
    !temporary.startsWith(runner + sep) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    Buffer.byteLength(join(temporary, "scoped_dirXXXXXX", "SingletonSocket")) >= 108 ||
    input.artifact !== join(input.root, "extractable.AppImage") ||
    !/^[A-Za-z0-9_./ -]+$/.test(temporary)
  )
    throw new Error("APPIMAGE_RUNTIME_PATH_INVALID")
  const artifact = input.artifact
  const artifactSha256 = input.artifactSha256
  const hash = await appImageRuntimeDigests(artifact, artifactSha256)
  const cache = join(temporary, "appimage_extracted_" + hash.md5)
  const executable = join(cache, desktopIdentity(input.kind).executableName)
  const name = "ps-desktop-qualification-" + createHash("sha256").update(executable).digest("hex").slice(0, 24)
  const plan = Object.freeze({
    artifact,
    artifactSha256,
    cache,
    executable,
    arguments: Object.freeze(["--appimage-extract-and-run"]),
    profile: Object.freeze({
      name,
      file: join(input.root, "appimage-runtime-apparmor-profile"),
      text: `abi <abi/4.0>,\nprofile "${name}" "${executable}" flags=(unconfined) {\n  userns,\n}\n`,
    }),
  })
  return {
    ...plan,
    async beforeLaunch() {
      const current = await lstat(temporary)
      if (
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.uid !== stat.uid ||
        (current.mode & 0o777) !== 0o700 ||
        (await realpath(temporary)) !== temporary
      )
        throw new Error("APPIMAGE_RUNTIME_PATH_INVALID")
      await appImageRuntimeDigests(artifact, artifactSha256)
      if (!(await absent(cache))) throw new Error("APPIMAGE_RUNTIME_CACHE_NOT_EMPTY")
    },
    async afterShutdown(proof: {
      applicationExited: boolean
      descendantsExited: boolean
      runtimeExitCode: number | null
    }) {
      if (
        proof.applicationExited !== true ||
        proof.descendantsExited !== true ||
        proof.runtimeExitCode !== 0 ||
        !(await absent(cache))
      )
        throw new Error("APPIMAGE_RUNTIME_CLEANUP_UNCONFIRMED")
      return {
        originalArtifactRuntime: true,
        mode: "extract-and-run",
        runtimeRemovedExtraction: true,
        fuseTested: false,
        doubleClickTested: false,
      }
    },
  }
}

/** Feed actual /proc observations for the owned runtime and its descendants.
 * AppImage's direct child execs AppRun and then Electron; renderers have other
 * parents. No attachment/API authority is granted from a pathname alone. */
export async function bindAppImageElectron(input: {
  runtimePid: number
  uid: number
  plan: { artifact: string; executable: string }
  payloadSha256: string
  processes: { pid: number; ppid: number; uid: number; executable: string }[]
}) {
  const runtime = input.processes.filter((item) => item.pid === input.runtimePid)
  const children = input.processes.filter(
    (item) => item.ppid === input.runtimePid && item.executable === input.plan.executable,
  )
  if (
    !Number.isSafeInteger(input.runtimePid) ||
    input.runtimePid <= 0 ||
    !Number.isSafeInteger(input.uid) ||
    input.uid < 0 ||
    runtime.length !== 1 ||
    runtime[0].uid !== input.uid ||
    runtime[0].executable !== input.plan.artifact ||
    children.length !== 1 ||
    !Number.isSafeInteger(children[0].pid) ||
    children[0].pid <= 0 ||
    children[0].uid !== input.uid
  )
    throw new Error("APPIMAGE_RUNTIME_OWNER_UNCONFIRMED")
  if (
    (await realpath(input.plan.executable)) !== input.plan.executable ||
    (await payloadFingerprint(input.plan.executable)).sha256 !== input.payloadSha256
  )
    throw new Error("APPIMAGE_RUNTIME_PAYLOAD_CHANGED")
  return children[0].pid
}
