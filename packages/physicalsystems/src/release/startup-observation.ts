// SPDX-License-Identifier: Apache-2.0
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import type { Writable } from "node:stream"

/** Private logging must never prevent a qualification receipt from finishing. */
export function observePrivateLog(log: Writable) {
  let failed = false
  log.on("error", () => {
    failed = true
  })
  return {
    finish(milliseconds = 3000): Promise<"COMPLETE" | "FAILED"> {
      return new Promise((resolve) => {
        let settled = false
        const done = (status: "COMPLETE" | "FAILED") => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          log.off("finish", finished)
          log.off("close", closed)
          log.off("error", broken)
          if (status === "FAILED") log.destroy()
          resolve(status)
        }
        const finished = () => done(failed ? "FAILED" : "COMPLETE")
        const closed = () => done(log.writableFinished && !failed ? "COMPLETE" : "FAILED")
        const broken = () => done("FAILED")
        const timer = setTimeout(broken, Math.min(3000, Math.max(1, milliseconds)))
        if (failed || log.destroyed) {
          done("FAILED")
          return
        }
        log.once("finish", finished)
        log.once("close", closed)
        log.once("error", broken)
        try {
          log.end()
        } catch {
          done("FAILED")
        }
      })
    },
  }
}

/** Fixed checkpoint names and states only; no private paths or file contents. */
export async function startupCheckpointDetail(profile: string, commandLines: string[] = []) {
  const checkpoints = [
    ["main-directories", ["data", "cache", "state", "desktop", "session", "workspace"], "directory"],
    ["settings", ["desktop/opencode.settings"], "file"],
    ["logging", ["desktop/logs"], "directory"],
    ["crashpad", ["desktop/Crashpad"], "directory"],
    ["operator", ["operator"], "directory"],
    ["attachment", ["desktop/runtime-attach.json"], "file"],
  ] as const
  const values = await Promise.all(
    checkpoints.map(async ([name, paths, kind]) => {
      const states = await Promise.all(
        paths.map(async (path) => {
          try {
            const stat = await lstat(join(profile, path))
            return !stat.isSymbolicLink() && (kind === "directory" ? stat.isDirectory() : stat.isFile())
              ? "present"
              : "invalid"
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"
          }
        }),
      )
      const state = states.includes("invalid")
        ? "invalid"
        : states.includes("unknown")
          ? "unknown"
          : states.every((value) => value === "present")
            ? "present"
            : "absent"
      return `${name}=${state}`
    }),
  )
  const kinds = new Set<string>()
  for (const line of commandLines) {
    const args = line.split("\0")
    const type = args.find((arg) => arg.startsWith("--type="))?.slice(7)
    kinds.add(type && ["renderer", "utility", "gpu-process", "zygote"].includes(type) ? type : "other")
  }
  return `Startup observations: ${values.join(", ")}; owned process kinds=${[...kinds].sort().join(",") || "unobserved"}. Observations do not establish application readiness.`
}
