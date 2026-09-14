import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor"
import { CancellationToken, DigestTransform, ProgressCallbackTransform } from "builder-util-runtime"
import type { DownloadCallOptions } from "builder-util-runtime/out/httpExecutor"
import { createWriteStream, write, writev } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import type { IncomingMessage, RequestOptions } from "node:http"
import { pipeline } from "node:stream/promises"
import type { PreviewUpdateAsset } from "./preview-update-download"

/** Tests may replace only the network transport; the library download pipeline
 * still executes. Production uses Electron's isolated, anonymous net session.
 */
export type PreviewUpdateRequest = (
  options: RequestOptions & { credentials: "omit"; useSessionCookies: false },
  response: (response: IncomingMessage) => void,
) => Electron.ClientRequest

/** The library supplies HTTP requests and digest/progress transforms. This
 * adapter directs the pipeline to our owned descriptor and bounds URLs/size.
 */
class SelectedAssetExecutor extends ElectronHttpExecutor {
  private requests = new Set<Electron.ClientRequest>()
  private responses = new Set<IncomingMessage>()
  private requestCount = 0
  private transfer = Promise.resolve()
  private stopped = false

  constructor(
    private readonly asset: PreviewUpdateAsset,
    private readonly file: FileHandle,
    token: CancellationToken,
    private readonly transport?: PreviewUpdateRequest,
  ) {
    super()
    token.on("cancel", () => this.abort())
  }

  private abort() {
    this.stopped = true
    for (const request of this.requests) request.abort()
    this.requests.clear()
    for (const response of this.responses) response.destroy()
    this.responses.clear()
  }

  async close() {
    this.abort()
    // Cancellation rejects the library promise before the stream has drained.
    // Settle it before the caller closes the descriptor or removes the temp file.
    await this.transfer.catch(() => {})
  }

  protected doDownload(options: RequestOptions, download: DownloadCallOptions, redirects: number) {
    super.doDownload(
      options,
      {
        ...download,
        // The library's default createWriteStream(destination) reopens a path.
        // Its response hook lets the same digest/progress transforms write to
        // our exclusive descriptor, even if the temp pathname is substituted.
        responseHandler: (response, done) => {
          this.transfer = pipeline(
            response,
            new ProgressCallbackTransform(this.asset.bytes, download.options.cancellationToken, (info) =>
              download.options.onProgress?.(info),
            ),
            new DigestTransform(this.asset.sha256, "sha256", "hex"),
            // The caller owns close even when pipeline destroys the stream on
            // error. A numeric fd also avoids FileHandle stream references
            // keeping handle.close() waiting after a successful finish.
            createWriteStream("", {
              fd: this.file.fd,
              autoClose: false,
              fs: { write, writev, close: (_fd: number, done: (error: Error | null) => void) => done(null) },
            }),
          )
          void this.transfer.then(() => done(null), done)
        },
      },
      redirects,
    )
  }

  createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): Electron.ClientRequest {
    this.requestCount++
    const anonymous = {
      ...options,
      method: "GET",
      headers: { Accept: "application/octet-stream", "Cache-Control": "no-store" },
      credentials: "omit" as const,
      useSessionCookies: false as const,
    }
    const observe = (response: IncomingMessage) => {
      if (this.stopped) {
        response.destroy()
        request.abort()
        return
      }
      this.responses.add(response)
      response.once("close", () => this.responses.delete(response))
      const fail = (code: string) => {
        response.destroy()
        request.emit("error", new Error(code))
        request.abort()
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        if (!this.redirectAllowed(response.headers.location)) return fail("PREVIEW_UPDATE_REDIRECT_INVALID")
        callback(response)
        response.resume()
        return
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300)
        return fail("PREVIEW_UPDATE_DOWNLOAD_FAILED")
      // The library follows any Location header, including on a 2xx response.
      // Electron returns a fresh headers object, so deleting a property would
      // not sanitize the value seen later by the library's redirect handler.
      if (response.headers.location !== undefined) return fail("PREVIEW_UPDATE_REDIRECT_INVALID")
      const length = response.headers["content-length"]
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== this.asset.bytes))
        return fail("PREVIEW_UPDATE_SIZE_MISMATCH")
      let bytes = 0
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > this.asset.bytes) fail("PREVIEW_UPDATE_SIZE_MISMATCH")
      })
      response.on("end", () => {
        if (bytes !== this.asset.bytes) fail("PREVIEW_UPDATE_SIZE_MISMATCH")
      })
      callback(response)
    }
    const request = this.transport ? this.transport(anonymous, observe) : super.createRequest(anonymous, observe)
    // Electron's writable request can close while its URLLoader is still active.
    // Retain these bounded references until the entire transfer has settled.
    this.requests.add(request)
    return request
  }

  protected addRedirectHandlers(
    request: Electron.ClientRequest,
    options: RequestOptions,
    reject: (error: Error) => void,
    _redirectCount: number,
    handler: (options: RequestOptions) => void,
  ) {
    request.on("redirect", (_status, _method, url) => {
      request.abort()
      if (this.stopped) return
      if (!this.redirectAllowed(url)) return reject(new Error("PREVIEW_UPDATE_REDIRECT_INVALID"))
      handler(ElectronHttpExecutor.prepareRedirectUrlOptions(url, options))
    })
  }

  private redirectAllowed(location?: string) {
    const url = URL.parse(location ?? "")
    return Boolean(
      this.requestCount <= 3 &&
        url &&
        url.protocol === "https:" &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.hash &&
        ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname),
    )
  }
}

/** Adapt an already selected release to the pinned library's real transfer
 * pipeline. HttpExecutor has no app, update checks, cache policy or installer.
 */
export async function transferPreviewUpdate(input: {
  asset: PreviewUpdateAsset
  file: string
  handle: FileHandle
  cancellationToken?: CancellationToken
  request?: PreviewUpdateRequest
  onProgress: (percent: number) => void
}) {
  const token = input.cancellationToken ?? new CancellationToken()
  const executor = new SelectedAssetExecutor(input.asset, input.handle, token, input.request)
  const timeout = setTimeout(() => token.cancel(), 5 * 60_000)
  try {
    await executor.download(new URL(input.asset.url), input.file, {
      sha2: input.asset.sha256,
      cancellationToken: token,
      onProgress: (info) => input.onProgress(info.percent),
    })
  } finally {
    clearTimeout(timeout)
    await executor.close()
    token.dispose()
  }
}
