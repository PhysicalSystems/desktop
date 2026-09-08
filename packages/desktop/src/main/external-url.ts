import { fileURLToPath } from "node:url"
import { spawn, type ChildProcess } from "node:child_process"

// OS browser routing must use the login session's directories, independently of
// the app and sidecar's private XDG profile. Do not inherit provider credentials,
// CI secrets, or runtime/loader hooks into the system launcher.
const externalLaunchEnvironmentKeys = [
  "HOME",
  "PATH",
  "BROWSER",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "SESSION_MANAGER",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "DESKTOP_SESSION",
  "KDE_FULL_SESSION",
  "KDE_SESSION_VERSION",
  "GNOME_DESKTOP_SESSION_ID",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const

export function snapshotExternalLaunchEnvironment(input: Readonly<NodeJS.ProcessEnv>): Readonly<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of externalLaunchEnvironmentKeys) {
    const value = input[key]
    if (typeof value === "string" && !value.includes("\0")) environment[key] = value
  }
  environment.PATH ??= "/usr/bin:/bin"
  return Object.freeze(environment)
}

type ExternalLauncherSpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; shell: false; stdio: "ignore"; detached: true },
) => Pick<ChildProcess, "once" | "unref">

export function createExternalURLOpener(input: {
  platform: NodeJS.Platform
  environment: Readonly<NodeJS.ProcessEnv>
  open: (url: string) => Promise<unknown>
  spawn?: ExternalLauncherSpawn
}) {
  const environment = snapshotExternalLaunchEnvironment(input.environment)
  const launch = input.spawn ?? spawn
  return async (value: string, timeoutMs = 5000): Promise<boolean> => {
    const url = resolveExternalURL(value)
    if (!url || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return false
    if (input.platform !== "linux") return openExternalTarget(url, input.open, timeoutMs)
    return new Promise<boolean>((resolve) => {
      let child: ReturnType<ExternalLauncherSpawn> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let finished = false
      const finish = (acknowledged: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        // A stalled launcher may still own a browser. Release only our process
        // handle: no signal, no assertion that the browser or login has stopped.
        child?.unref()
        resolve(acknowledged)
      }
      try {
        child = launch("/usr/bin/xdg-open", [url], {
          env: { ...environment },
          shell: false,
          stdio: "ignore",
          detached: true,
        })
        child.once("error", () => finish(false))
        child.once("exit", (code, signal) => finish(code === 0 && signal === null))
        if (!finished) timer = setTimeout(() => finish(false), timeoutMs)
      } catch {
        finish(false)
      }
    })
  }
}

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
