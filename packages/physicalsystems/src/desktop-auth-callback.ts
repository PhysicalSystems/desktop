// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"

/** One attempt, one loopback-only callback. No bearer credentials or local commands cross this listener. */
export async function createDesktopAuthCallback(state: string, signal: AbortSignal) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error("INVALID_AUTH_STATE")
  signal.throwIfAborted()
  const path = `/physicalsystems/auth/${randomBytes(32).toString("base64url")}`
  let redirectUri = ""
  let settled = false
  let accept!: (code: string) => void
  let reject!: (error: Error) => void
  const code = new Promise<string>((resolve, fail) => {
    accept = resolve
    reject = fail
  })
  // The browser can be slower than cancellation or startup failure.
  void code.catch(() => {})
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
    let target: URL
    try {
      target = new URL(request.url ?? "/", redirectUri)
    } catch {
      response.writeHead(404).end()
      return
    }
    if (
      settled ||
      signal.aborted ||
      request.method !== "GET" ||
      request.headers.host !== new URL(redirectUri).host ||
      target.origin !== new URL(redirectUri).origin ||
      target.pathname !== path ||
      target.searchParams.size !== 2 ||
      target.searchParams.getAll("state").length !== 1 ||
      target.searchParams.get("state") !== state ||
      target.searchParams.getAll("code").length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(target.searchParams.get("code") ?? "")
    ) {
      response.writeHead(404).end()
      return
    }
    settled = true
    response.once("finish", () => close())
    response.writeHead(303, { Location: "https://physicalsystems.ai/desktop/sign-in?complete=1" }).end()
    accept(target.searchParams.get("code")!)
  })
  server.maxHeadersCount = 16
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  const close = (force = false) => {
    signal.removeEventListener("abort", cancel)
    server.close()
    server.closeIdleConnections()
    if (force) server.closeAllConnections()
  }
  const cancel = () => {
    if (!settled) {
      settled = true
      reject(new Error("SIGN_IN_CANCELLED"))
    }
    close(true)
  }
  signal.addEventListener("abort", cancel, { once: true })
  await new Promise<void>((resolve, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail)
      const address = server.address()
      if (!address || typeof address === "string") {
        fail(new Error("CALLBACK_UNAVAILABLE"))
        return
      }
      redirectUri = `http://127.0.0.1:${address.port}${path}`
      resolve()
    })
  }).catch((error) => {
    cancel()
    throw error
  })
  if (signal.aborted) {
    cancel()
    signal.throwIfAborted()
  }
  return { redirectUri, code, close: cancel }
}
