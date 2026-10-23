// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { connect } from "node:net"
import { createDesktopAuthCallback } from "./desktop-auth-callback"

test("loopback callback rejects unrelated requests without consuming the one exact sign-in", async () => {
  const state = randomBytes(32).toString("base64url"),
    secret = randomBytes(32).toString("base64url")
  const controller = new AbortController()
  const callback = await createDesktopAuthCallback(state, controller.signal)
  try {
    expect(new URL(callback.redirectUri).hostname).toBe("127.0.0.1")
    for (const [url, init] of [
      [`${callback.redirectUri}?code=${secret}&state=wrong`, {}],
      [`${callback.redirectUri}?code=${secret}&state=${state}&extra=1`, {}],
      [`${callback.redirectUri}?code=${secret}&state=${state}&state=${state}`, {}],
      [`${callback.redirectUri}/other?code=${secret}&state=${state}`, {}],
      [`${callback.redirectUri}?code=${secret}&state=${state}`, { method: "POST" }],
      [`${callback.redirectUri}?code=${secret}&state=${state}`, { headers: { host: "attacker.invalid" } }],
    ] as [string, RequestInit][]) {
      expect((await fetch(url, init)).status).toBe(404)
    }
    const response = await fetch(`${callback.redirectUri}?code=${secret}&state=${state}`, { redirect: "manual" })
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("https://physicalsystems.ai/desktop/sign-in?complete=1")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await callback.code).toBe(secret)
    await expect(fetch(callback.redirectUri)).rejects.toThrow()
  } finally {
    callback.close()
  }
})

test("cancel closes the exact bound listener and rejects its pending code", async () => {
  const controller = new AbortController()
  const callback = await createDesktopAuthCallback(randomBytes(32).toString("base64url"), controller.signal)
  controller.abort()
  await expect(callback.code).rejects.toThrow("SIGN_IN_CANCELLED")
  await expect(fetch(callback.redirectUri)).rejects.toThrow()
})

test("cancel also closes accepted clients that never finish HTTP headers", async () => {
  const controller = new AbortController()
  const callback = await createDesktopAuthCallback(randomBytes(32).toString("base64url"), controller.signal)
  const address = new URL(callback.redirectUri)
  const socket = connect({ host: "127.0.0.1", port: Number(address.port) })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    socket.write(`GET ${address.pathname} HTTP/1.1\r\nHost: ${address.host}\r\n`)
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve())
      socket.on("error", () => {})
    })
    controller.abort()
    await closed
    await expect(callback.code).rejects.toThrow("SIGN_IN_CANCELLED")
  } finally {
    socket.destroy()
    callback.close()
  }
})
