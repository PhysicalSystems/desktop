import { fileURLToPath } from "node:url"

export function resolveExternalURL(value: string) {
  if (typeof value !== "string" || value.length > 8192 || !URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href
  return undefined
}

/** Acknowledges the OS handoff, not completion of a browser login. Never return
 * raw launcher errors or authorization URLs to logs. */
export async function openExternalTarget(value: string, open: (url: string) => Promise<unknown>, timeoutMs = 5000) {
  const url = resolveExternalURL(value)
  if (!url || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => open(url))
        .then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function resolveLocalFilePath(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol !== "file:" || url.hostname) return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}
