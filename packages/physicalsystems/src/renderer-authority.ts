// SPDX-License-Identifier: Apache-2.0
export function trustedRenderer(input: { windowMatches: boolean; mainFrame: boolean; url?: string; developmentURL?: string; packaged: boolean }) {
  if (!input.windowMatches || !input.mainFrame || !input.url) return false
  try {
    const url = new URL(input.url)
    if (url.protocol === "oc:" && url.hostname === "renderer" && !url.username && !url.password && !url.port) return true
    if (input.packaged || !input.developmentURL) return false
    const development = new URL(input.developmentURL)
    return ["http:", "https:"].includes(development.protocol) && url.origin === development.origin && !url.username && !url.password
  } catch { return false }
}
