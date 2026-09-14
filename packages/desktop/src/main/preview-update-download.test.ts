import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, request } from "node:http"
import type { Server } from "node:http"
import type { PreviewUpdateRequest } from "./preview-update-transfer"
import { transferPreviewUpdate } from "./preview-update-transfer"
import { CancellationToken } from "builder-util-runtime"
import { downloadPreviewUpdate, reverifyPreviewUpdate } from "./preview-update-download"
import type { PreviewUpdateAsset } from "./preview-update-download"

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("the transfer module loads with external dependencies under packaged Node ESM resolution", async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "preview-update-transfer.ts")],
    target: "node",
    format: "esm",
    packages: "external",
  })
  expect(build.success).toBe(true)
  const child = Bun.spawn(["node", "--input-type=module", "--eval", await build.outputs[0]!.text()], {
    cwd: join(import.meta.dir, "../.."),
    stdout: "ignore",
    stderr: "pipe",
  })
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(error)
  expect(code).toBe(0)
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

// Only the socket destination is replaced. ElectronHttpExecutor.download and
// its real stream/hash/progress pipeline process loopback HTTP responses.
async function transport(
  handler: (url: string, options: Parameters<PreviewUpdateRequest>[0]) => Promise<Response>,
  electronRedirectEvents = false,
): Promise<PreviewUpdateRequest> {
  let current: { url: string; options: Parameters<PreviewUpdateRequest>[0] }
  const server = createServer((_request, outgoing) => {
    void handler(current.url, current.options)
      .then(async (response) => {
        outgoing.statusCode = response.status
        response.headers.forEach((value, key) => outgoing.setHeader(key, value))
        if (response.body) for await (const chunk of response.body) outgoing.write(chunk)
        outgoing.end()
      })
      .catch(() => outgoing.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Loopback listener unavailable")
  servers.push(server)
  return (options, callback) => {
    current = { url: `${options.protocol}//${options.hostname}${options.path}`, options }
    // Node's ClientRequest provides the same stream/event operations used by
    // the real library. No Electron app or installer is created by these tests.
    const connection = request(
      { ...options, protocol: "http:", hostname: "127.0.0.1", port: address.port },
      (response) => {
        if (electronRedirectEvents && response.headers.location) {
          connection.emit("redirect", response.statusCode, "GET", response.headers.location)
          response.resume()
          return
        }
        callback(response)
      },
    )
    return connection as unknown as Electron.ClientRequest
  }
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
    request: await transport(async (url, options) => {
      calls.push(url)
      expect(options.method).toBe("GET")
      expect(options.useSessionCookies).toBe(false)
      expect(options.credentials).toBe("omit")
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
    }),
  })
  // Windows TEMP may contain an 8.3 alias; the downloader returns its canonical
  // owned directory, not the caller's original path spelling.
  expect(file).toBe(join(await realpath(f.directory), f.asset.name))
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
      request: await transport(async () => {
        throw new Error("must not request cached bytes")
      }),
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
        request: await transport(async () => {
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
        }),
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
      request: await transport(async () => {
        calls++
        return new Response(null, { status: 302, headers: { Location: location } })
      }),
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
    request: await transport(async () =>
      ++calls <= redirects
        ? new Response(null, {
            status: 307,
            headers: { Location: `https://objects.githubusercontent.com/fixture-${calls}` },
          })
        : new Response(f.bytes),
    ),
  })
  if (redirects === 3) expect(await result).toBe(join(await realpath(f.directory), f.asset.name))
  else await expect(result).rejects.toThrow("PREVIEW_UPDATE_REDIRECT_INVALID")
  expect(calls).toBe(4)
})

test.each(["allowed", "hostile", "excessive"])("handles Electron redirect events: %s", async (mode) => {
  const f = await fixture()
  let calls = 0
  const download = downloadPreviewUpdate({
    ...f,
    request: await transport(async () => {
      calls++
      if (mode === "hostile")
        return new Response(null, { status: 302, headers: { Location: "https://untrusted.example/file" } })
      if (calls <= (mode === "excessive" ? 4 : 3))
        return new Response(null, {
          status: 302,
          headers: { Location: `https://release-assets.githubusercontent.com/fixture-${calls}` },
        })
      return new Response(f.bytes)
    }, true),
  })
  if (mode === "allowed") expect(await readFile(await download)).toEqual(f.bytes)
  else await expect(download).rejects.toThrow("PREVIEW_UPDATE_REDIRECT_INVALID")
  expect(calls).toBe(mode === "hostile" ? 1 : 4)
})

test("rejects 200 Location headers with Electron's fresh-object headers getter", async () => {
  const f = await fixture()
  let calls = 0
  const connect = await transport(async () => {
    calls++
    return new Response(f.bytes, { headers: calls === 1 ? { Location: "https://untrusted.example/file" } : {} })
  })
  await expect(
    downloadPreviewUpdate({
      ...f,
      request: (options, callback) =>
        connect(options, (response) => {
          const headers = { ...response.headers }
          Object.defineProperty(response, "headers", { get: () => ({ ...headers }) })
          callback(response)
        }),
    }),
  ).rejects.toThrow("PREVIEW_UPDATE_REDIRECT_INVALID")
  expect(calls).toBe(1)
  expect(await readdir(f.directory)).toEqual([])
})

test.each(["symlink", "hardlink", "regular"])(
  "writes only the original descriptor after an in-flight %s substitution",
  async (mode) => {
    if (process.platform === "win32" && mode !== "regular") return
    const f = await fixture()
    const sentinel = join(f.root, "outside-sentinel")
    await writeFile(sentinel, "must remain unchanged", { mode: 0o600 })
    const detached = join(f.root, "original-private-partial")
    await expect(
      downloadPreviewUpdate({
        ...f,
        request: await transport(async () => {
          const partial = join(f.directory, (await readdir(f.directory))[0]!)
          await rename(partial, detached)
          if (mode === "symlink") await symlink(sentinel, partial)
          if (mode === "hardlink") await link(sentinel, partial)
          // Identical bytes and a private regular file would pass a rehash alone.
          if (mode === "regular") await writeFile(partial, f.bytes, { mode: 0o600 })
          return new Response(f.bytes)
        }),
      }),
    ).rejects.toThrow("PREVIEW_UPDATE_FILE_CHANGED")
    expect(await readFile(sentinel, "utf8")).toBe("must remain unchanged")
    expect(await readFile(detached)).toEqual(f.bytes)
    expect(await readdir(f.directory)).toEqual([])
  },
)

test("the real upstream digest rejects corrupt bytes before the cache verifier runs", async () => {
  const f = await fixture()
  const file = join(f.root, "private-partial")
  const handle = await open(file, "wx", 0o600)
  try {
    await expect(
      transferPreviewUpdate({
        asset: f.asset,
        file,
        handle,
        onProgress: () => {},
        request: await transport(async () => new Response(Buffer.alloc(f.bytes.length, "x"))),
      }),
    ).rejects.toMatchObject({ code: "ERR_CHECKSUM_MISMATCH" })
    expect((await handle.stat()).isFile()).toBe(true)
  } finally {
    await handle.close().catch(() => {})
  }
})

test("cancellation during the real response pipeline settles before the owned descriptor is closed", async () => {
  const f = await fixture()
  const file = join(f.root, "private-partial")
  const handle = await open(file, "wx", 0o600)
  const cancellationToken = new CancellationToken()
  const connect = await transport(async () => new Response(f.bytes))
  try {
    await expect(
      transferPreviewUpdate({
        asset: f.asset,
        file,
        handle,
        cancellationToken,
        onProgress: () => {},
        request: (options, callback) => {
          const connection = connect(options, callback)
          connection.on("response", (response) => response.once("data", () => cancellationToken.cancel()))
          return connection
        },
      }),
    ).rejects.toThrow("cancelled")
    expect((await handle.stat()).isFile()).toBe(true)
  } finally {
    await handle.close().catch(() => {})
  }
})

test("cancellation still aborts an Electron request that closed before receiving a response", async () => {
  const f = await fixture()
  const file = join(f.root, "private-partial")
  const handle = await open(file, "wx", 0o600)
  const cancellationToken = new CancellationToken()
  const connect = await transport(async () => new Promise<Response>(() => {}))
  let connection: Electron.ClientRequest | undefined
  try {
    await expect(
      transferPreviewUpdate({
        asset: f.asset,
        file,
        handle,
        cancellationToken,
        onProgress: () => {},
        request: (options, callback) => {
          connection = connect(options, callback)
          queueMicrotask(() => {
            // Electron closes its Writable when the request body is sent; its
            // URLLoader can still be waiting for response headers at this point.
            connection!.emit("close")
            cancellationToken.cancel()
          })
          return connection
        },
      }),
    ).rejects.toThrow("cancelled")
    expect((connection as unknown as { aborted: boolean }).aborted).toBe(true)
  } finally {
    await handle.close().catch(() => {})
  }
})

test("rejects mutable readiness and repairs only an owned regular corrupt cache entry by downloading again", async () => {
  const f = await fixture()
  const file = await downloadPreviewUpdate({ ...f, request: await transport(async () => new Response(f.bytes)) })
  await writeFile(file, Buffer.alloc(f.bytes.length, "x"))
  await expect(reverifyPreviewUpdate(file, f.asset)).rejects.toThrow("PREVIEW_UPDATE_HASH_MISMATCH")
  let calls = 0
  expect(
    await downloadPreviewUpdate({
      ...f,
      request: await transport(async () => {
        calls++
        return new Response(f.bytes)
      }),
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
        request: await transport(async () => {
          throw new Error("must not request")
        }),
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
  await writeFile(join(real, "sentinel"), "preserve", { mode: 0o600 })
  await symlink(real, f.directory, "junction")
  await expect(
    downloadPreviewUpdate({
      ...f,
      request: await transport(async () => {
        throw new Error("must not request")
      }),
    }),
  ).rejects.toThrow("PREVIEW_UPDATE_CACHE_UNSAFE")
  expect((await lstat(f.directory)).isSymbolicLink()).toBe(true)
  expect(await readdir(real)).toEqual(["sentinel"])
  expect(await readFile(join(real, "sentinel"), "utf8")).toBe("preserve")
  // Keep the rejected junction intact for ordinary recursive fixture cleanup.
  // Removing a junction with non-recursive rm is not portable in pinned Bun.
  const entry = await fixture()
  await mkdir(entry.directory, { mode: 0o700 })
  await mkdir(join(entry.directory, entry.asset.name))
  await expect(
    downloadPreviewUpdate({
      ...entry,
      request: await transport(async () => {
        throw new Error("must not request")
      }),
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
      request: await transport(async () => {
        throw new Error("must not request")
      }),
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
        request: await transport(async () => {
          throw new Error("must not request")
        }),
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
    request: await transport(async () => new Response(f.bytes)),
    onProgress: () => {
      f.asset.sha256 = "0".repeat(64)
      f.asset.bytes = 1
      throw new Error("private-credential-trap")
    },
  })
  await reverifyPreviewUpdate(file, expected)
})
