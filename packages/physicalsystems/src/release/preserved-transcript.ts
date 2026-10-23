// SPDX-License-Identifier: Apache-2.0
export async function readPreservedTranscript(request: (route: string) => Promise<Response>, sessionID: string) {
  const messages: Record<string, unknown>[] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let bytes = 0
  try {
    for (let index = 0; index < 32; index++) {
      // V2 cursors retain the initial order. Supplying both is rejected by the API.
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : { order: "asc" }) })
      const response = await request(`/api/session/${encodeURIComponent(sessionID)}/message?${query}`)
      if (!response.ok || !response.body) throw new Error()
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 4 * 1024 * 1024) {
            await reader.cancel()
            throw new Error()
          }
          chunks.push(chunk.value)
        }
      } finally {
        reader.releaseLock()
      }
      const page: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (
        !page ||
        typeof page !== "object" ||
        !("data" in page) ||
        !Array.isArray(page.data) ||
        page.data.length > 200 ||
        !("cursor" in page) ||
        !page.cursor ||
        typeof page.cursor !== "object" ||
        Array.isArray(page.cursor)
      )
        throw new Error()
      const next = "next" in page.cursor ? page.cursor.next : undefined
      // Even the last populated V2 page has a cursor; only an empty page proves EOF.
      if (page.data.length === 0) {
        if (next != null || messages.length === 0) throw new Error()
        return messages
      }
      if (typeof next !== "string" || !next || cursors.has(next)) throw new Error()
      cursors.add(next)
      cursor = next
      for (const message of page.data) {
        if (
          !message ||
          typeof message !== "object" ||
          Array.isArray(message) ||
          typeof message.id !== "string" ||
          !message.id ||
          typeof message.type !== "string" ||
          !message.type ||
          ids.has(message.id)
        )
          throw new Error()
        ids.add(message.id)
        // Preserve the API's durable sequence and every field used by the exact hash.
        messages.push(message)
      }
    }
  } catch {
    throw new Error("PACKAGED_REINSTALL_STATE_CHANGED")
  }
  throw new Error("PACKAGED_REINSTALL_STATE_CHANGED")
}
