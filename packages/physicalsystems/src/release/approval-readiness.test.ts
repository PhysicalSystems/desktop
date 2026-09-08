// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { legacyApprovalReady } from "./approval-readiness"

test("enabled controls cannot admit a click while the authoritative session is busy or retrying", async () => {
  let controls = 0
  let clicks = 0
  const ready = async () => {
    controls++
    return true
  }
  for (const value of [{ type: "busy" }, { type: "retry", attempt: 0, next: 0, message: "PRIVATE_PROVIDER_TEXT" }]) {
    if (await legacyApprovalReady(Response.json({ ses_current: value }), "ses_current", ready)) clicks++
    expect(controls).toBe(0)
    expect(clicks).toBe(0)
  }
  if (await legacyApprovalReady(Response.json({ ses_current: { type: "idle" } }), "ses_current", ready)) clicks++
  expect(controls).toBe(1)
  expect(clicks).toBe(1)
})

test("valid empty maps and absent sessions are idle only after every foreign entry validates", async () => {
  let controls = 0
  const ready = async () => {
    controls++
    return true
  }
  expect(await legacyApprovalReady(Response.json({}), "ses_current", ready)).toBe(true)
  const action = { reason: "reason", provider: "provider", title: "title", message: "message", label: "label" }
  for (const value of [
    { type: "idle", extra: "schema strips unknown fields" },
    { type: "busy" },
    { type: "retry", attempt: 1, next: Number.MAX_SAFE_INTEGER, message: "retry" },
    { type: "retry", attempt: 0, next: 1, message: "retry", action },
    { type: "retry", attempt: 0, next: 1, message: "retry", action: { ...action, link: "https://example.invalid" } },
  ])
    expect(await legacyApprovalReady(Response.json({ unrelated: value }), "ses_current", ready)).toBe(true)
  expect(controls).toBe(6)
  expect(await legacyApprovalReady(Response.json({}), "ses_current", async () => false)).toBe(false)
})

test("malformed success envelopes and foreign status records fail before controls without disclosing content", async () => {
  const trap = "PRIVATE_ENDPOINT_PROVIDER_CREDENTIAL"
  const action = { reason: trap, provider: trap, title: trap, message: trap, label: trap }
  const retry = { type: "retry", attempt: 0, next: 1, message: trap }
  let controls = 0
  const ready = async () => {
    controls++
    return true
  }
  const malformed = [
    null,
    [],
    "idle",
    1,
    true,
    { data: {} },
    { error: trap },
    { ok: true },
    { ses_current: { type: "busy" }, foreign: { type: "retry", message: trap } },
    ...[
      null,
      [],
      {},
      { type: trap },
      { type: "retry" },
      { ...retry, message: null },
      ...[-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1].flatMap((value) => [
        { ...retry, attempt: value },
        { ...retry, next: value },
      ]),
      ...[null, [], {}, { ...action, provider: 1 }, { ...action, link: null }].map((value) => ({
        ...retry,
        action: value,
      })),
    ].map((value) => ({ ses_current: { type: "idle" }, foreign: value })),
  ]
  for (const body of malformed) {
    const error = await legacyApprovalReady(Response.json(body), "ses_current", ready).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("PACKAGED_APPROVAL_NOT_READY")
    expect((error as Error).stack).not.toContain(trap)
  }
  expect(controls).toBe(0)
})

test("HTTP and JSON failures cannot reach controls or expose transport details", async () => {
  let reads = 0
  let controls = 0
  const ready = async () => {
    controls++
    return true
  }
  for (const status of [0, 201, 204, 301, 401, 403, 404, 500]) {
    await expect(
      legacyApprovalReady(
        {
          status,
          json: async () => {
            reads++
            return {}
          },
        },
        "ses_current",
        ready,
      ),
    ).rejects.toThrow("PACKAGED_APPROVAL_NOT_READY")
  }
  expect(reads).toBe(0)
  await expect(
    legacyApprovalReady(
      {
        status: 200,
        json: async () => {
          throw new Error("PRIVATE_JSON_ERROR")
        },
      },
      "ses_current",
      ready,
    ),
  ).rejects.toThrow("PACKAGED_APPROVAL_NOT_READY")
  expect(controls).toBe(0)
  await expect(
    legacyApprovalReady(Response.json({}), "ses_current", async () => {
      throw new Error("PRIVATE_CONTROLS_ERROR")
    }),
  ).rejects.toThrow("PACKAGED_APPROVAL_NOT_READY")
})
