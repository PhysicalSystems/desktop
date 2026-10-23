// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readPreservedTranscript } from "./preserved-transcript"

const message = (index: number) => ({ id: `msg_${index}`, type: "assistant", content: [{ text: `result ${index}` }] })
const page = (data: unknown[], next?: unknown) => ({ data, cursor: { next } })
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

test.each([14, 201])("preserves every ordered message across V2 cursors for %i messages", async (count) => {
  const messages = Array.from({ length: count }, (_, index) => message(index))
  const routes: string[] = []
  const result = await readPreservedTranscript(async (route) => {
    routes.push(route)
    if (routes.length === 1) return Response.json(page(messages.slice(0, 200), "opaque+/first="))
    if (routes.length === 2 && count > 200) return Response.json(page(messages.slice(200), "opaque-second"))
    return Response.json(page([], count > 200 ? null : undefined))
  }, "ses_owned")
  expect(routes).toEqual([
    "/api/session/ses_owned/message?limit=200&order=asc",
    "/api/session/ses_owned/message?limit=200&cursor=opaque%2B%2Ffirst%3D",
    ...(count > 200 ? ["/api/session/ses_owned/message?limit=200&cursor=opaque-second"] : []),
  ])
  expect(result).toEqual(messages)
  expect(hash(result)).toBe(hash(messages))
  expect(hash([...result].reverse())).not.toBe(hash(messages))
})

test.each([
  ["empty transcript", [page([])]],
  ["missing continuation", [page([message(1)])]],
  ["empty cursor", [page([message(1)], "")]],
  ["non-string cursor", [page([message(1)], 2)]],
  ["non-array data", [{ data: {}, cursor: {} }]],
  ["missing identity", [page([{ type: "assistant" }], "next")]],
  ["missing type", [page([{ id: "msg_1" }], "next")]],
  ["duplicate on page", [page([message(1), message(1)], "next")]],
  ["duplicate across pages", [page([message(1)], "first"), page([message(1)], "second")]],
  ["repeated cursor", [page([message(1)], "same"), page([message(2)], "same")]],
  ["cursor cycle", [page([message(1)], "first"), page([message(2)], "second"), page([message(3)], "first")]],
  ["empty page with continuation", [page([message(1)], "first"), page([], "second")]],
  [
    "oversized page",
    [
      page(
        Array.from({ length: 201 }, (_, index) => message(index)),
        "next",
      ),
    ],
  ],
] as const)("rejects incomplete or ambiguous transcript: %s", async (_, pages) => {
  let calls = 0
  await expect(
    readPreservedTranscript(async () => Response.json(pages[calls++] ?? page([])), "ses_owned"),
  ).rejects.toThrow("PACKAGED_REINSTALL_STATE_CHANGED")
  expect(calls).toBeLessThanOrEqual(pages.length)
})

test("rejects HTTP and malformed JSON responses without exposing response content", async () => {
  for (const response of [new Response("private response", { status: 500 }), new Response("private malformed JSON")])
    await expect(readPreservedTranscript(async () => response, "ses_owned")).rejects.toThrow(
      "PACKAGED_REINSTALL_STATE_CHANGED",
    )
})

test("bounds aggregate UTF-8 transcript bytes across pages", async () => {
  let calls = 0
  await expect(
    readPreservedTranscript(async () => {
      calls++
      return Response.json(page([{ ...message(calls), text: "é".repeat(1024 * 1024) }], `cursor-${calls}`))
    }, "ses_owned"),
  ).rejects.toThrow("PACKAGED_REINSTALL_STATE_CHANGED")
  expect(calls).toBe(2)
})

test("bounds never-ending unique pages without accepting a partial transcript", async () => {
  let calls = 0
  await expect(
    readPreservedTranscript(async () => {
      calls++
      return Response.json(page([message(calls)], `cursor-${calls}`))
    }, "ses_owned"),
  ).rejects.toThrow("PACKAGED_REINSTALL_STATE_CHANGED")
  expect(calls).toBe(32)
})
