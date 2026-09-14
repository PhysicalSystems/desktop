// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createLinuxRestartObservation,
  parseLinuxBrowserEndpoint,
  readLinuxBrowserEndpoint,
  readLinuxBrowserPid,
} from "./preview-update-linux-observation"

const browserPath = "/devtools/browser/01234567-89ab-cdef-0123-456789abcdef"
const nextPath = "/devtools/browser/11234567-89ab-cdef-0123-456789abcdef"

test("DevToolsActivePort accepts only a bounded port and exact browser path", () => {
  expect(parseLinuxBrowserEndpoint(`45123\n${browserPath}\n`)).toBe(`ws://127.0.0.1:45123${browserPath}`)
  for (const invalid of [
    `65536\n${browserPath}`,
    `0\n${browserPath}`,
    `123\nws://remote.test${browserPath}`,
    `123\n${browserPath}?private=1`,
    `123\n${browserPath}\nextra`,
    `123\n/devtools/page/abc`,
  ])
    expect(parseLinuxBrowserEndpoint(invalid)).toBeUndefined()
})

test.skipIf(process.platform !== "linux")(
  "owned profile endpoint requires a new browser UUID, permits reused port and refuses ambiguity",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "preview-browser-"))
    try {
      const previous = `ws://127.0.0.1:45123${browserPath}`
      const uid = process.getuid!()
      expect(await readLinuxBrowserEndpoint(profile, previous, uid)).toBeUndefined()
      await mkdir(join(profile, "desktop"), { mode: 0o700 })
      await writeFile(join(profile, "desktop", "DevToolsActivePort"), `45123\n${browserPath}`)
      expect(await readLinuxBrowserEndpoint(profile, previous, uid)).toBeUndefined()
      await writeFile(join(profile, "desktop", "DevToolsActivePort"), `45123\n${nextPath}`)
      expect(await readLinuxBrowserEndpoint(profile, previous, uid)).toBe(`ws://127.0.0.1:45123${nextPath}`)
      await mkdir(join(profile, "session"), { mode: 0o700 })
      await writeFile(join(profile, "session", "DevToolsActivePort"), `45124\n${nextPath}`)
      await expect(readLinuxBrowserEndpoint(profile, previous, uid)).rejects.toThrow("ENDPOINT_AMBIGUOUS")
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "linux")(
  "profile endpoint refuses symlinks, hardlinks, wrong ownership and oversized files",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "preview-browser-"))
    const previous = `ws://127.0.0.1:45123${browserPath}`
    const uid = process.getuid!()
    const file = join(profile, "desktop", "DevToolsActivePort")
    try {
      await mkdir(join(profile, "desktop"), { mode: 0o700 })
      await writeFile(join(profile, "authored"), `45123\n${nextPath}`)
      await symlink(join(profile, "authored"), file)
      await expect(readLinuxBrowserEndpoint(profile, previous, uid)).rejects.toThrow("FILE_UNOWNED")
      await rm(file)
      await link(join(profile, "authored"), file)
      await expect(readLinuxBrowserEndpoint(profile, previous, uid)).rejects.toThrow("FILE_UNOWNED")
      await rm(file)
      await writeFile(file, `45123\n${nextPath}`)
      await expect(readLinuxBrowserEndpoint(profile, previous, uid + 1)).rejects.toThrow("FILE_UNOWNED")
      await writeFile(file, "a".repeat(1025))
      await expect(readLinuxBrowserEndpoint(profile, previous, uid)).rejects.toThrow("FILE_UNOWNED")
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  },
)

async function browserFixture(reply: unknown, run: (endpoint: string, requests: unknown[]) => Promise<void>) {
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === browserPath && server.upgrade(request)) return
      return new Response("missing", { status: 404 })
    },
    websocket: {
      message(socket, message) {
        requests.push(JSON.parse(String(message)))
        if (reply !== undefined) socket.send(JSON.stringify(reply))
      },
    },
  })
  try {
    await run(`ws://127.0.0.1:${server.port}${browserPath}`, requests)
  } finally {
    await server.stop(true)
  }
}

test("read-only browser RPC selects the browser PID, ignoring renderer and helper PIDs", async () => {
  await browserFixture(
    {
      id: 1,
      result: {
        processInfo: [
          { type: "renderer", id: 456 },
          { type: "browser", id: 123 },
          { type: "GPU", id: 789 },
        ],
      },
    },
    async (endpoint, requests) => {
      expect(await readLinuxBrowserPid(endpoint)).toBe(123)
      expect(requests).toEqual([{ id: 1, method: "SystemInfo.getProcessInfo" }])
    },
  )
})

test("browser RPC rejects absent, ambiguous and invalid browser identities", async () => {
  for (const rows of [
    [],
    [{ type: "renderer", id: 123 }],
    [{ type: "browser", id: 0 }],
    [{ type: "browser", id: "123" }],
    [
      { type: "browser", id: 123 },
      { type: "browser", id: 456 },
    ],
  ]) {
    await browserFixture({ id: 1, result: { processInfo: rows } }, async (endpoint) => {
      await expect(readLinuxBrowserPid(endpoint)).rejects.toThrow("BROWSER_REPLY_INVALID")
    })
  }
})

test("browser RPC bounds unavailable replies and refuses a non-loopback endpoint before connecting", async () => {
  await browserFixture(undefined, async (endpoint) => {
    expect(await readLinuxBrowserPid(endpoint, 50)).toBeUndefined()
    expect(() => readLinuxBrowserPid(endpoint.replace("127.0.0.1", "localhost"))).toThrow("ENDPOINT_INVALID")
    expect(() => readLinuxBrowserPid(`${endpoint}?token=anything`)).toThrow("ENDPOINT_INVALID")
  })
})

test("restart observations stay finite and do not expose native private text", () => {
  const tracker = createLinuxRestartObservation()
  for (let sample = 0; sample < 1030; sample++) tracker.sample("restart-poll")
  tracker.observe("freshEndpointSeen")
  tracker.observe("browserIdentityMatched")
  tracker.observeStderr("private path and arbitrary application error")
  expect(Object.values(tracker.snapshot().stderr).some(Boolean)).toBe(false)
  tracker.observeStderr("[ERROR:relauncher.cc] No CHILD_")
  tracker.observeStderr("PROCESS_EXE\nbase::LaunchProcess failed\nread: unexpected result 0\n")
  tracker.observeStderr(
    "failed to launch program\nThe SUID sandbox helper binary was found, but is not configured correctly",
  )
  const snapshot = tracker.snapshot()
  expect(snapshot).toMatchObject({
    samples: 1024,
    observationsTruncated: true,
    freshEndpointSeen: true,
    browserIdentityMatched: true,
  })
  expect(snapshot.stderr).toEqual({
    noChildProcessExe: true,
    processLaunchFailed: true,
    relauncherSyncFailed: true,
    relaunchTargetFailed: true,
    sandboxFatal: true,
  })
  expect(JSON.stringify(snapshot)).not.toContain("private")
  expect(JSON.stringify(snapshot)).not.toContain("relauncher.cc")
  snapshot.stderr.sandboxFatal = false
  expect(tracker.snapshot().stderr.sandboxFatal).toBe(true)
})
