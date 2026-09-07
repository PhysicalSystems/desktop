// SPDX-License-Identifier: Apache-2.0
export function physicalCredentials() {
  return process.env.PHYSICALSYSTEMS_DESKTOP === "1" || !!process.env.PHYSICALSYSTEMS_AUTH_URL
}

export async function nativeCredentialRequest(operation: string, input: Record<string, unknown> = {}) {
  const value = process.env.PHYSICALSYSTEMS_AUTH_URL
  const token = process.env.PHYSICALSYSTEMS_AGENT_TOKEN
  if (!value || !token) throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE")
  const url = new URL(value)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/auth" || url.search || url.hash || url.username || url.password) {
    throw new Error("INVALID_CREDENTIAL_STORE_ENDPOINT")
  }
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation, ...input }), signal: AbortSignal.timeout(6500), redirect: "error",
  })
  if (!response.ok) throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE")
  return response.json() as Promise<Record<string, unknown>>
}
