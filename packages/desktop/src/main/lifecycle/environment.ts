import { startupTrace } from "../startup-trace"
import http from "node:http"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { Effect, Path } from "effect"
import { DesktopPaths } from "../paths"
import { registerRendererProtocol, setDockIcon, setProtocolReporter } from "../windows"
import { scoped } from "../native/logging"

// electron-context-menu attaches to every existing and future window, so it can load once the first
// window is up instead of holding up startup with its dependency tree.
export const installContextMenu = Effect.gen(function* () {
  const { default: contextMenu } = yield* Effect.promise(() => import("electron-context-menu"))
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })
})

export const prepareApplicationEnvironment = Effect.gen(function* () {
  startupTrace("SYSTEM_CERTIFICATES_BEFORE")
  yield* loadSystemCertificates
  startupTrace("SYSTEM_CERTIFICATES_AFTER")
  yield* loadProxyEnvironment
})

// Never reload ambient provider credentials or config from a login shell.
export const preferApplicationEnvironment = Effect.sync(() => {
  process.env.OPENCODE_CLIENT = "desktop"
})

export const prepareDesktop = Effect.gen(function* () {
  const path = yield* Path.Path
  const paths = yield* DesktopPaths.resolve

  const runFork = Effect.runForkWith(yield* Effect.context())
  setProtocolReporter((level, message, data) =>
    runFork(scoped("protocol", level === "error" ? Effect.logError(message, data) : Effect.logWarning(message, data))),
  )
  registerRendererProtocol(paths.rendererRoot)
  setDockIcon(path, paths)
})

export const loadProxyEnvironment = Effect.gen(function* () {
  yield* Effect.try(() => {
    ensureLoopbackNoProxy()
    // Electron 41.2 has a newer Node API than the current @types/node package.
    const proxyAwareHttp = http as typeof http & { setGlobalProxyFromEnv(): void }
    proxyAwareHttp.setGlobalProxyFromEnv()
  }).pipe(Effect.catch((error) => Effect.logWarning("failed to load proxy environment", { error })))
})

const loadSystemCertificates = Effect.try({
  try: () => {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  },
  catch: (error) => error,
}).pipe(Effect.catch((error) => Effect.logWarning("failed to load system certificates", { error })))

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]

  ;["NO_PROXY", "no_proxy"].forEach((key) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)

    loopback.forEach((host) => {
      if (!items.some((value) => value.toLowerCase() === host)) items.push(host)
    })
    process.env[key] = items.join(",")
  })
}
