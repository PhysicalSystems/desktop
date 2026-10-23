// Unknown paths and release/manual runs retain the full suite. Only these
// established source areas can opt out of native installer qualification on PRs.
export function desktopChecks(paths, event, sourceSha = "") {
  const full = { source: true, release: true, appearance: true }
  if (event !== "pull_request" || sourceSha || !paths.length) return full

  const scopes = paths.map((path) => {
    // Packaged prompts and skills are runtime inputs, even when written in Markdown.
    if (path.startsWith("packages/physicalsystems/vendor/")) return full
    if (
      /^[^/]+\.md$/.test(path) ||
      /^(docs|release)\/.*\.md$/.test(path) ||
      /^packages\/[^/]+\/(README\.md|docs\/.*\.(md|png|svg))$/.test(path)
    )
      return { source: false, release: false, appearance: false }

    if (/^packages\/app\/(src|test-browser|e2e)\//.test(path)) {
      if (/(updater|preview-update|desktop-native)/.test(path)) return full
      return { source: true, release: false, appearance: true }
    }
    if (
      /^packages\/(core|server|tui)\/(src|test)\//.test(path) ||
      (path.startsWith("packages/physicalsystems/src/") && !path.startsWith("packages/physicalsystems/src/release/"))
    )
      return { source: true, release: false, appearance: false }
    return full
  })
  return {
    source: scopes.some((scope) => scope.source),
    release: scopes.some((scope) => scope.release),
    appearance: scopes.some((scope) => scope.appearance),
  }
}
