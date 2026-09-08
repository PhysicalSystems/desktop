// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { startOwnedReviewBrowser } from "./owned-review-browser"
import { startOwnedWindowsReviewBrowser } from "./owned-windows-review-browser"
import { verifyOwnedReviewContext, type OwnedProviderReviewSession } from "./owned-provider-review"
import { validateProviderBrowserReviewContext, type ProviderBrowserReviewContext } from "./provider-browser-review"

const failure = () => Error("BROWSER_HANDOFF_UNCONFIRMED")

/** Actual native browser transport, exclusively to an owned local fixture.
 * This operation never calls a provider/auth endpoint and cannot satisfy the
 * independent native-provider-browser-probe requirement. */
export async function runOwnedBrowserHandoffReview(
  input: {
    env: NodeJS.ProcessEnv
    root: string
    artifact: string
    context: ProviderBrowserReviewContext
    runtimeEnvironment: NodeJS.ProcessEnv
    withSession<T>(
      environment: NodeJS.ProcessEnv,
      review: (session: OwnedProviderReviewSession) => Promise<T>,
    ): Promise<T>
  },
  io: {
    startBrowser?: typeof startOwnedReviewBrowser
    platform?: NodeJS.Platform
    timeoutMs?: number
  } = {},
) {
  if (!input.env.PS_BROWSER_REVIEW || input.env.PS_BROWSER_REVIEW === "0")
    return { status: "NOT_TESTED" as const, reason: "NO_BROWSER_REVIEW" as const }
  if (input.env.PS_BROWSER_REVIEW !== "1") throw failure()
  const platform = io.platform ?? process.platform
  const root = await verifyOwnedReviewContext(input, platform)
  const context = validateProviderBrowserReviewContext(input.context)
  const timeoutMs = io.timeoutMs ?? 12000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12000) throw failure()
  const nonce = randomBytes(32).toString("hex")
  const path = `/physicalsystems-browser-review/${nonce}`
  let host: string | undefined
  let requestObserved = false
  let receiveRequest = () => {}
  const requestArrived = new Promise<void>((resolve) => {
    receiveRequest = resolve
  })
  const server = createServer(
    { maxHeaderSize: 4096, requestTimeout: 2000, headersTimeout: 2000 },
    (request, response) => {
      if (
        request.method !== "GET" ||
        request.url !== path ||
        request.headers.host !== host ||
        request.socket.remoteAddress !== "127.0.0.1" ||
        request.headers["content-length"] ||
        request.headers["transfer-encoding"]
      ) {
        response.writeHead(404, { connection: "close" }).end()
        return
      }
      requestObserved = true
      receiveRequest()
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        connection: "close",
      })
      response.end("Owned desktop browser handoff check. No provider sign-in is performed.")
    },
  )
  server.maxConnections = 8
  server.on("clientError", (_error, socket) => {
    socket.destroy()
  })
  const browserRoot = join(root, "browser")
  let browser: Awaited<ReturnType<typeof startOwnedReviewBrowser>> | undefined
  let uncertain = false
  let acquiring = false
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(failure()))
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw failure()
    host = `127.0.0.1:${address.port}`
    const probeURL = `http://${host}${path}`
    await mkdir(browserRoot, { mode: 0o700 })
    acquiring = true
    browser = await (
      io.startBrowser ?? (platform === "win32" ? startOwnedWindowsReviewBrowser : startOwnedReviewBrowser)
    )({ env: input.env, root: browserRoot, probeURL })
    acquiring = false
    acquiring = true
    const observed = await input.withSession(
      {
        ...input.runtimeEnvironment,
        ...browser.environment,
        PHYSICALSYSTEMS_ALLOW_DEVICES: "0",
        PHYSICALSYSTEMS_PROVIDER_REVIEW: "",
        PHYSICALSYSTEMS_PROVIDER_REVIEW_NONCE: "",
      },
      async (session) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let openerAcknowledged = false
        let expired = false
        try {
          return await Promise.race([
            (async () => {
              const opened = await session.openBrowser(probeURL)
              // The product opener can itself return false on its deadline
              // while the underlying OS handoff remains unresolved.
              openerAcknowledged = opened === true
              if (!openerAcknowledged) uncertain = true
              if (expired || !openerAcknowledged) return false
              return (await browser!.confirmHandoff(probeURL)) && (await requestArrived.then(() => true))
            })(),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => {
                expired = true
                // An unresolved OS handoff may still launch a process after
                // cleanup. Read-only CDP/HTTP timeouts carry no such authority.
                if (!openerAcknowledged) uncertain = true
                resolve(false)
              }, timeoutMs)
            }),
          ])
        } catch {
          if (!openerAcknowledged) uncertain = true
          return false
        } finally {
          clearTimeout(timer)
        }
      },
    )
    acquiring = false
    if (!observed || !requestObserved) throw failure()
    return {
      status: "OBSERVED" as const,
      context,
      browserHandoffAcknowledged: true as const,
      ownedLoopbackRequestObserved: true as const,
      ownedBrowserTargetObserved: true as const,
      ownedBrowserProcessAndProfileCleanup: true as const,
      probeNonceSha256: createHash("sha256").update(nonce).digest("hex"),
      providerSignIn: "NOT_TESTED" as const,
    }
  } catch {
    throw failure()
  } finally {
    if (acquiring) uncertain = true
    try {
      await browser?.stop({ retainProfile: uncertain })
    } catch {
      uncertain = true
    }
    server.closeAllConnections()
    let timer: ReturnType<typeof setTimeout> | undefined
    const closed = await Promise.race([
      new Promise<boolean>((resolve) =>
        server.close((error) => resolve(!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING")),
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000)
      }),
    ])
    clearTimeout(timer)
    if (!closed) uncertain = true
    if (!uncertain)
      await rm(root, { recursive: true }).catch(() => {
        uncertain = true
      })
    if (uncertain) throw Error("BROWSER_HANDOFF_CLEANUP_UNCONFIRMED")
  }
}
