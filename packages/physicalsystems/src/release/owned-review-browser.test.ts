// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  reviewBrowserCrashDatabase,
  reviewBrowserCrashpad,
  reviewBrowserProcess,
  reviewBrowserSignalIdentity,
  reviewBrowserTargets,
  reviewBrowserUid,
  settleReviewBrowserCleanup,
} from "./owned-review-browser"

// Only inert /proc strings, fake HTTP and timer-only subprocesses. No native browser, process
// signaling, credential store or device is started by these regressions.
const status = "Name:\tchrome\nUid:\t1001\t1001\t1001\t1001\n"
const identity = { pid: 400, state: "S", group: 400, session: 400, birth: "123456" }

test("Chrome Crashpad uses exact branded Linux config path, executable and NUL-delimited argument", () => {
  const database = reviewBrowserCrashDatabase("/owned/review browser")
  expect(database).toBe("/owned/review browser/config/google-chrome/Crash Reports")
  const executable = "/opt/google/chrome/chrome_crashpad_handler"
  expect(
    reviewBrowserCrashpad({ executable, database, command: `${executable}\0--database=${database}\0--monitor-self\0` }),
  ).toBe(true)
  for (const command of [
    `${executable}\0--database=/owned/review browser/profile/Crashpad\0`,
    `${executable}\0--database=${database}-unowned\0`,
    `${executable}\0--note=--database=${database}\0`,
    `${executable} --database=${database}`,
  ])
    expect(reviewBrowserCrashpad({ executable, database, command })).toBe(false)
  expect(
    reviewBrowserCrashpad({
      executable: "/other/chrome_crashpad_handler",
      database,
      command: `--database=${database}\0`,
    }),
  ).toBe(false)
})

test("ownership rejects changed PID/birth/session/group and every changed native UID before signaling", () => {
  reviewBrowserSignalIdentity(identity, { ...identity }, status, 1001)
  for (const changed of [{ pid: 401 }, { birth: "123457" }, { session: 401 }, { group: 401 }])
    expect(() => reviewBrowserSignalIdentity(identity, { ...identity, ...changed }, status, 1001)).toThrow(
      "PROVIDER_REVIEW_BROWSER_UNCONFIRMED",
    )
  for (let index = 0; index < 4; index++) {
    const uids = [1001, 1001, 1001, 1001]
    uids[index] = 0
    expect(() => reviewBrowserUid(`Uid:\t${uids.join("\t")}\n`, 1001)).toThrow("PROVIDER_REVIEW_BROWSER_UNCONFIRMED")
  }
  expect(() => reviewBrowserUid(status + status, 1001)).toThrow()
  expect(() => reviewBrowserUid(status, 0)).toThrow()
  const fields = ["399", "400", "400", ...Array(15).fill("0"), "123456", "0"]
  expect(reviewBrowserProcess(`400 (Chrome (renderer)) S ${fields.join(" ")}`)).toEqual(identity)
})

test("read-only discovery tolerates refused, 503 and truncated responses before a valid target", async () => {
  const responses = [
    () => {
      throw new Error("PRIVATE-TRANSPORT")
    },
    () => new Response("PRIVATE-ERROR", { status: 503 }),
    () => new Response(""),
    () => new Response('[{"type":"page",'),
    () => new Response(JSON.stringify([{ type: "page", url: "about:blank", privateExtra: "PRIVATE" }])),
  ]
  for (let index = 0; index < responses.length; index++) {
    const result = await reviewBrowserTargets("http://127.0.0.1:12345", {
      fetcher: async (_url, options) => {
        expect(options?.redirect).toBe("error")
        expect(options?.signal).toBeDefined()
        return responses[index]!()
      },
    })
    expect(result).toEqual(index === 4 ? [{ type: "page", url: "about:blank" }] : undefined)
    expect(JSON.stringify(result) ?? "").not.toContain("PRIVATE")
  }
})

test("discovery caps stream bytes before consuming an oversized body and bounds stalled transports", async () => {
  let pulls = 0
  let cancelled = false
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(128 * 1024))
      },
      cancel() {
        cancelled = true
      },
    }),
  )
  expect(await reviewBrowserTargets("http://127.0.0.1:12345", { fetcher: async () => response })).toBeUndefined()
  expect(pulls).toBeLessThanOrEqual(4)
  expect(cancelled).toBe(true)
  for (const fetcher of [
    () => new Promise<Response>(() => {}),
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {})
          },
        }),
      ),
  ]) {
    const start = Date.now()
    expect(await reviewBrowserTargets("http://127.0.0.1:12345", { fetcher, timeoutMs: 10 })).toBeUndefined()
    expect(Date.now() - start).toBeLessThan(500)
  }
})

test("discovery rejects unowned endpoints and malformed or excessive target metadata", async () => {
  for (const origin of [
    "https://127.0.0.1:1234",
    "http://localhost:1234",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:1234/private",
  ])
    await expect(reviewBrowserTargets(origin)).rejects.toThrow("PROVIDER_REVIEW_BROWSER_UNCONFIRMED")
  for (const value of [{}, [null], [{ type: "page" }], Array(129).fill({ type: "page", url: "about:blank" })])
    expect(
      await reviewBrowserTargets("http://127.0.0.1:12345", {
        fetcher: async () => new Response(JSON.stringify(value)),
      }),
    ).toBeUndefined()
})

test("cleanup releases only its controller handle while preserving the original failure", async () => {
  let unrefs = 0
  const child = {
    unref() {
      unrefs++
    },
  }
  const original = Error("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
  await expect(
    settleReviewBrowserCleanup(child, async () => {
      throw original
    }),
  ).rejects.toBe(original)
  expect(unrefs).toBe(1)
  expect(await settleReviewBrowserCleanup(child, async () => "stopped")).toBe("stopped")
  expect(unrefs).toBe(2)
})

test("failed controller writes its receipt and exits while the inert retained child/profile remain", async () => {
  const helper = new URL("./owned-review-browser.ts", import.meta.url).href
  for (const corrected of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "retained-review-fixture-"))
    const receipt = join(root, "receipt.json")
    const retained = join(root, "profile.txt")
    const finished = join(root, "inert-child-finished")
    const childCode = `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(finished)}, 'finished'), 1200);`
    const script = `
      import { spawn } from 'node:child_process';
      import { writeFile } from 'node:fs/promises';
      import { settleReviewBrowserCleanup } from ${JSON.stringify(helper)};
      await writeFile(${JSON.stringify(retained)}, 'retained inert profile');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { detached:true, stdio:'ignore' });
      await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });
      const cleanup = async () => { throw Error('PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED'); };
      try { ${corrected ? "await settleReviewBrowserCleanup(child, cleanup)" : "await cleanup()"}; }
      catch { await writeFile(${JSON.stringify(receipt)}, JSON.stringify({ result:'FAIL', cleanup:'UNCONFIRMED', retained:true })); process.exitCode=1; }
    `
    const controller = spawn(process.execPath, ["-e", script], { stdio: "ignore" })
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("INERT_CONTROLLER_TIMEOUT")), 5000)
        controller.once("exit", (code) => {
          clearTimeout(timer)
          resolve(code)
        })
        controller.once("error", () => {
          clearTimeout(timer)
          reject(Error("INERT_CONTROLLER_START_FAILED"))
        })
      })
      expect(code).toBe(1)
      expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({
        result: "FAIL",
        cleanup: "UNCONFIRMED",
        retained: true,
      })
      expect(await readFile(retained, "utf8")).toBe("retained inert profile")
      // The old referenced controller cannot exit until the child self-finishes.
      // The corrected controller finishes with no process signal or file removal.
      expect(
        await readFile(finished).then(
          () => true,
          () => false,
        ),
      ).toBe(!corrected)
      const until = Date.now() + 2500
      while (
        !(await readFile(finished).then(
          () => true,
          () => false,
        )) &&
        Date.now() < until
      )
        await new Promise((resolve) => setTimeout(resolve, 20))
      expect(await readFile(finished, "utf8")).toBe("finished")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}, 10000)
