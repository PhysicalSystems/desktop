// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, win32 } from "node:path"
import { Script } from "node:vm"
import type { Writable } from "node:stream"
import { finished } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { openPackagedArchive, packagedArchiveReader } from "./packaged-archive"
import { qualificationFailureCode } from "./qualification"

const desktopManifest = fileURLToPath(new URL("../../../desktop/package.json", import.meta.url))
const desktopRequire = createRequire(desktopManifest)
const builderRequire = createRequire(desktopRequire.resolve("electron-builder/package.json"))
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"))
const asar = appBuilderRequire("@electron/asar") as {
  createPackage: (source: string, destination: string) => Promise<Writable>
  extractFile: (archive: string, member: string) => Buffer
  getRawHeader: (archive: string) => { header: unknown; headerSize: number }
}
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "physical-packaged-archive-"))
  roots.push(root)
  const source = join(root, "source")
  await mkdir(join(source, "out/main"), { recursive: true })
  await mkdir(join(source, "out/legal"), { recursive: true })
  await writeFile(join(source, "out/main/index.js"), "synthetic fixture main")
  await writeFile(join(source, "out/legal/manifest.json"), '{"scope":"synthetic fixture"}')
  await writeFile(join(source, "out/legal/malformed.json"), "credential-trap must never leave diagnostics")
  await writeFile(join(source, "package.json"), '{"version":"0.1.0-beta.1"}')
  const archive = join(root, "app.asar")
  // The pinned writer resolves with out.end(), before the pending write has
  // necessarily finished. Await its actual stream completion before reading.
  await finished(await asar.createPackage(source, archive))
  return archive
}

test("reproduces the pinned ASAR Windows directory-walk failure and reads the same header after normalization", async () => {
  const archive = await fixture()
  const filename = join(dirname(appBuilderRequire.resolve("@electron/asar")), "filesystem.js")
  const localRequire = createRequire(filename)
  // Run the actual pinned library source with Node's Windows path implementation.
  // This exercises its directory walker on Linux without copying the implementation
  // into the test or pretending a Windows executable was launched.
  const module = {
    exports: {} as {
      Filesystem: new (root: string) => {
        setHeader: (header: unknown, size: number) => void
        getFile: (member: string) => { size: number }
      }
    },
  }
  const script = new Script(`(function(require, module, exports) { ${await readFile(filename, "utf8")}\n})`, {
    filename,
  })
  script.runInThisContext()((name: string) => (name === "path" ? win32 : localRequire(name)), module, module.exports)
  const filesystem = new module.exports.Filesystem("C:\\qualification\\app.asar")
  const header = asar.getRawHeader(archive)
  filesystem.setHeader(structuredClone(header.header), header.headerSize)
  expect(() => filesystem.getFile("out/main/index.js")).toThrow("was not found in this archive")
  const paths: string[] = []
  const reader = packagedArchiveReader(
    {
      extractFile(_archive, member) {
        paths.push(member)
        const file = filesystem.getFile(member)
        return Buffer.alloc(file.size, "x")
      },
    },
    archive,
    "win32",
  )
  expect(reader.read("out/main/index.js").length).toBe(Buffer.byteLength("synthetic fixture main"))
  expect(reader.read("out/legal/manifest.json").length).toBeGreaterThan(0)
  expect(paths).toEqual(["out\\main\\index.js", "out\\legal\\manifest.json"])
})

test("reads a real packaged ASAR and top-level metadata with the host path semantics", async () => {
  const reader = openPackagedArchive(desktopManifest, await fixture())
  expect(reader.read("out/main/index.js").toString()).toBe("synthetic fixture main")
  expect(reader.json("package.json")).toEqual({ version: "0.1.0-beta.1" })
  expect(reader.json("out/legal/manifest.json")).toEqual({ scope: "synthetic fixture" })
})

test("archive and malformed metadata failures expose only specific authored qualification codes", async () => {
  const reader = openPackagedArchive(desktopManifest, await fixture())
  for (const [run, code] of [
    [() => reader.read("out/main/absent.js"), "PACKAGED_RUNTIME_READ_FAILED"],
    [() => reader.json("out/legal/malformed.json"), "PACKAGED_RUNTIME_JSON_INVALID"],
    [
      () => openPackagedArchive("/qualification-missing/package.json", "private-credential-trap"),
      "PACKAGED_ARCHIVE_DEPENDENCY_UNAVAILABLE",
    ],
  ] as const) {
    expect(run).toThrow(code)
    try {
      run()
    } catch (error) {
      expect(String(error)).not.toContain("credential-trap")
      expect(qualificationFailureCode(error)).toBe(code)
    }
  }
  for (const json of ["null", "[]", "true", '"credential-trap"']) {
    const invalid = packagedArchiveReader(
      {
        extractFile() {
          return Buffer.from(json)
        },
      },
      "fixture",
    )
    expect(() => invalid.json("package.json")).toThrow("PACKAGED_RUNTIME_JSON_INVALID")
  }
  const broken = packagedArchiveReader(
    {
      extractFile() {
        throw new Error("private path and credential-trap")
      },
    },
    "fixture",
  )
  expect(() => broken.read("out/main/index.js")).toThrow("PACKAGED_RUNTIME_READ_FAILED")
})

test("rejects traversal, mixed separators, absolute paths and empty runtime members before extraction", () => {
  const calls: string[] = []
  const reader = packagedArchiveReader(
    {
      extractFile(_archive, member) {
        calls.push(member)
        return Buffer.alloc(0)
      },
    },
    "fixture",
    "win32",
  )
  for (const member of [
    "../main.js",
    "/out/main.js",
    "out//main.js",
    "out/./main.js",
    "out\\main.js",
    "C:/out/main.js",
    "out/\0main.js",
  ])
    expect(() => reader.read(member)).toThrow("PACKAGED_ARCHIVE_MEMBER_INVALID")
  expect(calls).toHaveLength(0)
  expect(() => reader.read("out/main/index.js")).toThrow("PACKAGED_RUNTIME_FILE_EMPTY")
})
