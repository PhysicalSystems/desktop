// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import {
  reviewBrowserCrashDatabase,
  reviewBrowserCrashpad,
  reviewBrowserProcess,
  reviewBrowserSignalIdentity,
  reviewBrowserTargets,
  reviewBrowserUid,
} from "./owned-review-browser"

// Only inert /proc strings and fake HTTP responses. No native browser, process
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
