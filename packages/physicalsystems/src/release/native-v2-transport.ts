// SPDX-License-Identifier: Apache-2.0
import type { createV2TransportObservation, V2TransportObservation } from "./native-v2-observation"

/** Authenticated fixture transport after the caller has independently verified
 * the running process's attachment. No redirects, arbitrary routes or origins. */
export function ownedV2CredentialTransport(
  attachment: { url: string; username: string; password: string; directory: string; sessionId: string },
  fetcher: (input: URL, init: RequestInit) => Promise<Response> = fetch,
  observation?: Pick<ReturnType<typeof createV2TransportObservation>, "observe">,
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
      init.method === "GET" && ["/api/integration/openai", "/api/model", "/api/session/active", session].includes(route)
    const prompt = init.method === "POST" && route === session + "/prompt"
    if (!noContent && !read && !prompt) throw new Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
    const routeKind =
      route === "/api/integration/openai"
        ? "integration"
        : route === "/api/integration/openai/connect/key"
          ? "key-write"
          : route.startsWith("/api/credential/")
            ? "credential-remove"
            : route === "/api/model"
              ? "catalog"
              : route === "/api/session/active"
                ? "active"
                : route === session
                  ? "session-read"
                  : route === session + "/model"
                    ? "model-switch"
                    : "prompt"
    const checkpoint: V2TransportObservation = { routeKind, method: init.method, outcome: "pending" }
    observation?.observe(checkpoint)
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
      if (response.status >= 100 && response.status <= 599) checkpoint.status = response.status
      checkpoint.outcome = "response"
      observation?.observe(checkpoint)
      if (response.status !== (noContent ? 204 : 200)) throw new Error()
      if (noContent) {
        checkpoint.outcome = "accepted"
        observation?.observe(checkpoint)
        return undefined
      }
      checkpoint.envelopeValid = false
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
      // integration.get is Location.response(UndefinedOr(Integration.Info)).
      // HttpApiBuilder uses JSON.stringify, which omits its undefined data field.
      // This is a legitimate registration state only for this scoped GET.
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        (!("data" in result) && route !== "/api/integration/openai")
      )
        throw new Error()
      checkpoint.envelopeValid = true
      if (route === "/api/integration/openai" || route === "/api/model") {
        checkpoint.locationMatched =
          result.location?.directory === bound.directory && result.location?.workspaceID === undefined
        if (!checkpoint.locationMatched) throw new Error()
      }
      if (route === session) {
        checkpoint.locationMatched =
          result.data?.location?.directory === bound.directory && result.data?.location?.workspaceID === undefined
        if (result.data?.id !== bound.sessionId || !checkpoint.locationMatched) throw new Error()
      }
      checkpoint.outcome = "accepted"
      observation?.observe(checkpoint)
      return result
    } catch {
      checkpoint.outcome = "rejected"
      observation?.observe(checkpoint)
      throw new Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
    }
  }
}
