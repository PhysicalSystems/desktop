import { startupTrace } from "../startup-trace"
import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { enableCompileCache } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { app } from "electron"
import "../external-opener"
import { physicalDeviceConnections, physicalEnvironment } from "../../../../physicalsystems/src/environment"
import { APP_ID, APP_NAME, PHYSICAL_IDENTITY } from "../constants"

const testOnboarding = process.env.OPENCODE_TEST_ONBOARDING === "1"

const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

// Runs synchronously from the entry module, before Chromium is ready: command-line switches only
// take effect before ready, the single-instance lock is scoped to userData, and the early window
// needs userData to find the persisted window list and state.
export function configureApplication() {
  const physicalRoot = process.env.PHYSICALSYSTEMS_DATA_DIR || path.join(app.getPath("appData"), PHYSICAL_IDENTITY.profileDirectory)
  const devices = physicalDeviceConnections(PHYSICAL_IDENTITY.kind, app.isPackaged, process.env)
  const scoped = physicalEnvironment(process.env, physicalRoot)
  for (const key of Object.keys(process.env)) if (!(key in scoped)) delete process.env[key]
  Object.assign(process.env, scoped)
  process.env.PHYSICALSYSTEMS_ALLOW_DEVICES = devices ? "1" : "0"
  for (const name of ["data", "config", "cache", "state", "desktop", "session", "workspace"])
    mkdirSync(path.join(physicalRoot, name), { recursive: true, mode: 0o700 })
  try {
    process.chdir(path.join(physicalRoot, "workspace"))
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  app.setName(APP_NAME)
  app.setAppUserModelId(APP_ID)
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)

  if (!app.isPackaged && process.env.PHYSICALSYSTEMS_DEBUG_PORT)
    app.commandLine.appendSwitch("remote-debugging-port", process.env.PHYSICALSYSTEMS_DEBUG_PORT)

  const testRoot = createTestRoot()
  app.setPath("userData", testRoot ? path.join(testRoot, "desktop") : path.join(physicalRoot, "desktop"))

  app.setPath("sessionData", path.join(physicalRoot, "session"))

  if (testRoot) {
    app.setPath("sessionData", path.join(testRoot, "session"))

    if (testOnboarding) app.setPath("documents", path.join(testRoot, "documents"))
  }

  // V8 bytecode for the main bundle survives between launches, like the renderer's code cache.
  enableCompileCache(path.join(app.getPath("userData"), "compile-cache"))
}

export function acquireApplicationLock() {
  startupTrace("INSTANCE_LOCK_BEFORE")
  if (app.requestSingleInstanceLock()) { startupTrace("INSTANCE_LOCK_ACQUIRED"); return true }
  startupTrace("INSTANCE_LOCK_DENIED")
  app.quit()

  return false
}

function createTestRoot() {
  const root = testOnboarding
    ? path.join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    : process.env.OPENCODE_DESKTOP_TEST_ROOT

  if (!root) return undefined

  if (testOnboarding) rmSync(root, { recursive: true, force: true })

  for (const dir of ["data", "config", "cache", "state", "desktop", "session", "documents"])
    mkdirSync(path.join(root, dir), { recursive: true })

  if (testOnboarding) process.env.OPENCODE_DB = ":memory:"

  process.env.XDG_DATA_HOME = path.join(root, "data")
  process.env.XDG_CONFIG_HOME = path.join(root, "config")
  process.env.XDG_CACHE_HOME = path.join(root, "cache")
  process.env.XDG_STATE_HOME = path.join(root, "state")

  return root
}
