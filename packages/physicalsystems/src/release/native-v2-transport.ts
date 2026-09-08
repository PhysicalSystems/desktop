// SPDX-License-Identifier: Apache-2.0

/** Authenticated fixture transport after the caller has independently verified
 * the running process's attachment. No redirects, arbitrary routes or origins. */
export function ownedV2CredentialTransport(
  attachment: { url: string; username: string; password: string; directory: string; sessionId: string },
  fetcher: (input: URL, init: RequestInit) => Promise<Response> = fetch,
) {
  const bound = { ...attachment }
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(bound.url) ||
    Number(new URL(bound.url).port) > 65535 ||
    !/^ses_[a-zA-Z0-9_-]{1,252}$/.test(bound.sessionId) ||
    !bound.directory ||
    !bound.username ||
    !bound.password
  )
    throw new Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
  return async (route: string, init: { method: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal }) => {
    const session = `/api/session/${bound.sessionId}`
    const noContent =
      (init.method === "POST" && (route === "/api/integration/openai/connect/key" || route === session + "/model")) ||
      (init.method === "DELETE" && /^\/api\/credential\/cred_[a-zA-Z0-9]{1,128}$/.test(route))
    const read =
      init.method === "GET" && ["/api/integration/openai", "/api/model", "/api/session/active"].includes(route)
    const prompt = init.method === "POST" && route === session + "/prompt"
    if (!noContent && !read && !prompt) throw new Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
    try {
      const url = new URL(route, bound.url)
      url.searchParams.set("location[directory]", bound.directory)
      const response = await fetcher(url, {
        method: init.method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${bound.username}:${bound.password}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal || AbortSignal.timeout(6000),
        redirect: "error",
      })
      if (response.status !== (noContent ? 204 : 200)) throw new Error()
      if (noContent) return undefined
      if (!response.body) throw new Error()
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 2 * 1024 * 1024) throw new Error()
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
      if (!result || typeof result !== "object" || Array.isArray(result) || !("data" in result)) throw new Error()
      if (route === "/api/integration/openai" || route === "/api/model") {
        if (result.location?.directory !== bound.directory || result.location?.workspaceID !== undefined)
          throw new Error()
      }
      return result
    } catch {
      throw new Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
    }
  }
}
