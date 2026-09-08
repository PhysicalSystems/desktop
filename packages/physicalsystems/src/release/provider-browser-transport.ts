// SPDX-License-Identifier: Apache-2.0
import type { ProviderBrowserReviewRequest } from "./provider-browser-review"

/** Only the owned native controller may supply this already-verified attachment.
 * The QA route allowlist is separate from the inert credential probe. */
export function providerBrowserReviewTransport(
  attachment: { url: string; directory: string; username: string; password: string },
  fetcher: (input: URL, init: RequestInit) => Promise<Response> = fetch,
): ProviderBrowserReviewRequest {
  const bound = { ...attachment }
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(bound.url) ||
    Number(new URL(bound.url).port) > 65535 ||
    !bound.directory ||
    bound.username !== "opencode" ||
    !bound.password
  )
    throw new Error("PROVIDER_REVIEW_UNCONFIRMED")
  return async (route, init) => {
    try {
      const method = init.method
      const integration = method === "GET" && route === "/api/integration/openai"
      const connect = method === "POST" && route === "/api/integration/openai/connect/oauth"
      const attempt =
        (method === "GET" || method === "DELETE") && /^\/api\/integration\/attempt\/con_[a-zA-Z0-9]{1,128}$/.test(route)
      const remove = method === "DELETE" && /^\/api\/credential\/cred_[a-zA-Z0-9]{1,128}$/.test(route)
      if (!integration && !connect && !attempt && !remove) throw new Error()
      if (connect && JSON.stringify(init.body) !== JSON.stringify({ methodID: "chatgpt-headless", inputs: {} }))
        throw new Error()
      if (!connect && init.body !== undefined) throw new Error()
      const url = new URL(route, bound.url)
      url.searchParams.set("location[directory]", bound.directory)
      const response = await fetcher(url, {
        method,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        headers: {
          Authorization: `Basic ${Buffer.from(`${bound.username}:${bound.password}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        signal: init.signal,
        redirect: "error",
      })
      if (response.status !== (method === "DELETE" ? 204 : 200)) {
        await response.body?.cancel().catch(() => {})
        throw new Error()
      }
      if (method === "DELETE") return undefined
      if (!response.body) throw new Error()
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 256 * 1024) throw new Error()
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("data" in value) ||
        value.location?.directory !== bound.directory ||
        value.location?.workspaceID !== undefined
      )
        throw new Error()
      return value
    } catch {
      throw new Error("PROVIDER_REVIEW_UNCONFIRMED")
    }
  }
}
