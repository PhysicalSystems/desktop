// SPDX-License-Identifier: Apache-2.0

/** One read-only discovery attempt. Startup ownership and retries belong to the caller. */
export async function probePackagedRenderer(port: number, timeoutMs = 3000) {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3000
  )
    throw new Error("PACKAGED_DEBUG_ENDPOINT_INVALID")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    })
    if (response.status !== 200 || !response.body) return
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 65536) return
      chunks.push(chunk.value)
    }
    const targets: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
    if (!Array.isArray(targets)) return
    for (const target of targets) {
      if (
        !target ||
        typeof target !== "object" ||
        Array.isArray(target) ||
        target.type !== "page" ||
        typeof target.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(target.id) ||
        typeof target.url !== "string" ||
        !target.url.startsWith("oc://renderer/") ||
        target.webSocketDebuggerUrl !== `ws://127.0.0.1:${port}/devtools/page/${target.id}`
      )
        continue
      return { id: target.id, webSocketDebuggerUrl: target.webSocketDebuggerUrl as string }
    }
  } catch {
    // A fresh CDP endpoint can refuse connections or return partial JSON while
    // its renderer starts. Neither condition is evidence that the app exited.
    return
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
