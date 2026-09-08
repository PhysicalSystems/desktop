// SPDX-License-Identifier: Apache-2.0
/** Desktop credentials cross only the existing authenticated operator gateway. */
export function physicalCredentials(env: NodeJS.ProcessEnv = process.env) {
  return env.PHYSICALSYSTEMS_DESKTOP === "1" || !!env.PHYSICALSYSTEMS_AUTH_URL
}

export async function nativeCredentialRequest(
  operation: string,
  input: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  try {
    if (!["all", "set", "remove"].includes(operation)) throw new Error()
    const endpoint = env.PHYSICALSYSTEMS_AUTH_URL
    const token = env.PHYSICALSYSTEMS_AGENT_TOKEN
    if (!endpoint || !token) throw new Error()
    const url = new URL(endpoint)
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== "/auth" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error()
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...input, operation }),
      signal: AbortSignal.timeout(6500),
      redirect: "error",
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new Error()
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 1024 * 1024) throw new Error()
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString())
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    if (operation !== "all" && !("saved" in value && value.saved === true)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE")
  }
}
