import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadPreviewUpdate, reverifyPreviewUpdate } from "./preview-update-download"
import type { PreviewUpdateAsset } from "./preview-update-download"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "physical-preview-download-"))
  roots.push(root)
  const name = "physical-systems-desktop-0.1.0-beta.7-linux-x64.deb"
  const bytes = Buffer.from("inert package fixture; never an executable")
  const asset: PreviewUpdateAsset = {
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: `https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0-beta.7/${name}`,
  }
  return { root, directory: join(root, "cache"), asset, bytes }
}

function stream(chunks: Uint8Array[]) {
  let index = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]!)
        else controller.close()
      },
    }),
  )
}

test("downloads anonymous bounded chunks through an owned CDN into private files and reuses only rehashed bytes", async () => {
  const f = await fixture()
  const calls: string[] = []
  const progress: number[] = []
  const file = await downloadPreviewUpdate({
    ...f,
    onProgress: (value) => progress.push(value),
    fetch: async (url, options) => {
      calls.push(url)
      expect(options.method).toBe("GET")
      expect(options.redirect).toBe("manual")
      expect(options.credentials).toBe("omit")
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(new Headers(options.headers).has("Authorization")).toBe(false)
      expect(new Headers(options.headers).has("Cookie")).toBe(false)
      const files = await readdir(f.directory)
      expect(files).toHaveLength(1)
      expect(files[0]).toEndWith(".partial")
      if (process.platform !== "win32") {
        expect((await lstat(f.directory)).mode & 0o777).toBe(0o700)
        expect((await lstat(join(f.directory, files[0]!))).mode & 0o777).toBe(0o600)
      }
      if (calls.length === 1)
        return new Response(null, {
          status: 302,
          headers: { Location: "https://release-assets.githubusercontent.com/fixture" },
        })
      return stream([f.bytes.subarray(0, 7), f.bytes.subarray(7)])
    },
  })
  expect(file).toBe(join(f.directory, f.asset.name))
  expect(await readFile(file)).toEqual(f.bytes)
  expect(await readdir(f.directory)).toEqual([f.asset.name])
  expect(progress[0]).toBe(0)
  expect(progress.at(-1)).toBe(100)
  expect(
    progress.every((value, index) => value >= 0 && value <= 100 && (index === 0 || value >= progress[index - 1]!)),
  ).toBe(true)
  await reverifyPreviewUpdate(file, f.asset)
  expect(
    await downloadPreviewUpdate({
      ...f,
      fetch: async () => {
        throw new Error("must not request cached bytes")
      },
    }),
  ).toBe(file)
  expect(calls).toHaveLength(2)
})

test.each(["length", "overrun", "truncated", "hash", "http", "stream", "transport"])(
  "rejects %s failures and removes only its own partial file",
  async (mode) => {
    const f = await fixture()
    await mkdir(f.directory, { mode: 0o700 })
    await writeFile(join(f.directory, "other-entry"), "preserve", { mode: 0o600 })
    await expect(
      downloadPreviewUpdate({
        ...f,
        fetch: async () => {
          if (mode === "transport") throw new Error("private-credential-trap")
          if (mode === "length")
            return new Response(f.bytes, { headers: { "Content-Length": String(f.asset.bytes + 1) } })
          if (mode === "http") return new Response("private-credential-trap", { status: 503 })
          if (mode === "overrun") return stream([f.bytes, Buffer.from("extra")])
          if (mode === "truncated") return stream([f.bytes.subarray(1)])
          if (mode === "hash") return stream([Buffer.alloc(f.bytes.length, "x")])
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("private-credential-trap"))
              },
            }),
          )
        },
      }),
    ).rejects.toThrow(/^PREVIEW_UPDATE_(?:SIZE_MISMATCH|HASH_MISMATCH|DOWNLOAD_FAILED)$/)
    expect(await readdir(f.directory)).toEqual(["other-entry"])
    expect(await readFile(join(f.directory, "other-entry"), "utf8")).toBe("preserve")
  },
)

test.each([
  "https://untrusted.example/installer",
  "http://release-assets.githubusercontent.com/fixture",
  "https://release-assets.githubusercontent.com.evil.example/fixture",
  "https://user@release-assets.githubusercontent.com/fixture",
  "https://release-assets.githubusercontent.com:444/fixture",
  "https://release-assets.githubusercontent.com/fixture#fragment",
  "/relative",
])("rejects redirect outside the exact HTTPS storage allowlist: %s", async (location) => {
  const f = await fixture()
  let calls = 0
  await expect(
    downloadPreviewUpdate({
      ...f,
      fetch: async () => {
        calls++
        return new Response(null, { status: 302, headers: { Location: location } })
      },
    }),
  ).rejects.toThrow("PREVIEW_UPDATE_REDIRECT_INVALID")
  expect(calls).toBe(1)
  expect(await readdir(f.directory)).toEqual([])
})

test.each([3, 4])("allows at most three CDN redirects: %s", async (redirects) => {
  const f = await fixture()
  let calls = 0
  const result = downloadPreviewUpdate({
    ...f,
    fetch: async () =>
      ++calls <= redirects
        ? new Response(null, {
            status: 307,
            headers: { Location: `https://objects.githubusercontent.com/fixture-${calls}` },
          })
        : new Response(f.bytes),
  })
  if (redirects === 3) expect(await result).toBe(join(f.directory, f.asset.name))
  else await expect(result).rejects.toThrow("PREVIEW_UPDATE_REDIRECT_INVALID")
  expect(calls).toBe(4)
})

test("rejects mutable readiness and repairs only an owned regular corrupt cache entry by downloading again", async () => {
  const f = await fixture()
  const file = await downloadPreviewUpdate({ ...f, fetch: async () => new Response(f.bytes) })
  await writeFile(file, Buffer.alloc(f.bytes.length, "x"))
  await expect(reverifyPreviewUpdate(file, f.asset)).rejects.toThrow("PREVIEW_UPDATE_HASH_MISMATCH")
  let calls = 0
  expect(
    await downloadPreviewUpdate({
      ...f,
      fetch: async () => {
        calls++
        return new Response(f.bytes)
      },
    }),
  ).toBe(file)
  expect(calls).toBe(1)
  await writeFile(file, "truncated")
  await expect(reverifyPreviewUpdate(file, f.asset)).rejects.toThrow("PREVIEW_UPDATE_SIZE_MISMATCH")
})

test.skipIf(process.platform === "win32")(
  "rejects cache-file symlinks and hardlinks without touching their targets",
  async () => {
    const f = await fixture()
    await mkdir(f.directory, { mode: 0o700 })
    const victim = join(f.root, "unrelated")
    await writeFile(victim, f.bytes, { mode: 0o600 })
    const file = join(f.directory, f.asset.name)
    await symlink(victim, file)
    await expect(reverifyPreviewUpdate(file, f.asset)).rejects.toThrow("PREVIEW_UPDATE_FILE_UNSAFE")
    await expect(
      downloadPreviewUpdate({
        ...f,
        fetch: async () => {
          throw new Error("must not request")
        },
      }),
    ).rejects.toThrow("PREVIEW_UPDATE_FILE_UNSAFE")
    expect(await readFile(victim)).toEqual(f.bytes)
    await rm(file)
    await link(victim, file)
    await expect(reverifyPreviewUpdate(file, f.asset)).rejects.toThrow("PREVIEW_UPDATE_FILE_UNSAFE")
    expect(await readFile(victim)).toEqual(f.bytes)
  },
)

test("rejects directory links and non-file cache entries", async () => {
  const f = await fixture()
  const real = join(f.root, "real")
  await mkdir(real, { mode: 0o700 })
  await symlink(real, f.directory, "junction")
  await expect(
    downloadPreviewUpdate({
      ...f,
      fetch: async () => {
        throw new Error("must not request")
      },
    }),
  ).rejects.toThrow("PREVIEW_UPDATE_CACHE_UNSAFE")
  await rm(f.directory)
  await mkdir(f.directory, { mode: 0o700 })
  await mkdir(join(f.directory, f.asset.name))
  await expect(
    downloadPreviewUpdate({
      ...f,
      fetch: async () => {
        throw new Error("must not request")
      },
    }),
  ).rejects.toThrow("PREVIEW_UPDATE_FILE_UNSAFE")
})

test.skipIf(process.platform === "win32")("rejects cache directories readable by other users", async () => {
  const f = await fixture()
  await mkdir(f.directory, { mode: 0o700 })
  await chmod(f.directory, 0o755)
  await expect(
    downloadPreviewUpdate({
      ...f,
      fetch: async () => {
        throw new Error("must not request")
      },
    }),
  ).rejects.toThrow("PREVIEW_UPDATE_CACHE_UNSAFE")
})

test.each(["name", "url", "size", "oversize", "hash"])(
  "rejects malformed asset %s before filesystem or network work",
  async (change) => {
    const f = await fixture()
    if (change === "name") f.asset.name = "../../installer.deb"
    if (change === "url") f.asset.url = "https://github.com/anomalyco/opencode/releases/download/version/file.exe"
    if (change === "size") f.asset.bytes = 0
    if (change === "oversize") f.asset.bytes = 2 * 1024 ** 3 + 1
    if (change === "hash") f.asset.sha256 = "invalid"
    await expect(
      downloadPreviewUpdate({
        ...f,
        fetch: async () => {
          throw new Error("must not request")
        },
      }),
    ).rejects.toThrow("PREVIEW_UPDATE_ASSET_INVALID")
    expect(await readdir(f.root)).toEqual([])
  },
)

test("presentation callbacks cannot mutate frozen expectations or leak exceptions", async () => {
  const f = await fixture()
  const expected = { ...f.asset }
  const file = await downloadPreviewUpdate({
    ...f,
    fetch: async () => new Response(f.bytes),
    onProgress: () => {
      f.asset.sha256 = "0".repeat(64)
      f.asset.bytes = 1
      throw new Error("private-credential-trap")
    },
  })
  await reverifyPreviewUpdate(file, expected)
})
