export * as DesktopCli from "./desktop-cli"

import { app } from "electron"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { DesktopPaths } from "../paths"

export interface Resolved {
  readonly version: string
  readonly command: readonly string[]
  readonly binary?: string
}
export interface Interface {
  readonly resolve: Effect.Effect<Resolved>
  readonly install: Effect.Effect<string, Error>
}
export class Service extends Context.Service<Service, Interface>()("opencode/desktop/DesktopCli") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const paths = yield* DesktopPaths.resolve
  const resources = app.isPackaged ? process.resourcesPath : paths.developmentResourcesRoot
  const binary = path.join(resources, process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli")
  const resolve = yield* Effect.cached(Effect.gen(function* () {
    const version = (yield* fs.readFileString(path.join(resources, "opencode-cli.version"))).trim()
    if (!/^2\.\d+\.\d+$/.test(version) || !(yield* fs.exists(binary)))
      return yield* Effect.die(new Error("PHYSICALSYSTEMS_OWNED_RUNTIME_REQUIRED"))
    // The app owns this child and confirms its exit before installing an update,
    // so Windows never needs a shared, version-only CLI cache or global install.
    return { version, binary, command: [binary] } satisfies Resolved
  }).pipe(Effect.orDie))
  return Service.of({ resolve, install: Effect.fail(new Error("PHYSICALSYSTEMS_OWNED_RUNTIME_REQUIRED")) })
}))
