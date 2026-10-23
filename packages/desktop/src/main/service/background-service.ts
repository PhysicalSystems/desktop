export * as BackgroundService from "./background-service"

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { setTimeout } from "node:timers/promises"
import { Context, Effect, Layer } from "effect"
import { agentDatabaseName } from "../../../../physicalsystems/src/release/agent-channel"
import { createProcessStopper } from "../../../../physicalsystems/src/lifecycle"
import { ownPhysicalServer, physicalRuntime } from "../physical-runtime"
import { DesktopCli } from "./desktop-cli"
import { SidecarCredentials } from "./sidecar-credentials"

export interface Interface {
  readonly connection: Effect.Effect<SidecarCredentials.Data>
  readonly reconnect: Effect.Effect<SidecarCredentials.Data>
}
export class Service extends Context.Service<Service, Interface>()("opencode/desktop/BackgroundService") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const desktopCli = yield* DesktopCli.Service
  const connection = yield* Effect.cached(Effect.gen(function* () {
    const cli = yield* desktopCli.resolve
    return yield* Effect.tryPromise(() => connect(cli)).pipe(Effect.orDie)
  }))
  // An owned service is never replaced or adopted behind an operator's active work.
  return Service.of({ connection, reconnect: connection })
}))

async function connect(cli: DesktopCli.Resolved): Promise<SidecarCredentials.Data> {
  const physical = await physicalRuntime()
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer()
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      if (!address || typeof address === "string") { socket.close(); reject(new Error("SERVER_PORT_UNAVAILABLE")); return }
      socket.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
  // Port allocation yielded; shutdown may have closed the operator in that interval.
  physicalRuntime()
  const password = randomUUID() + randomUUID()
  const url = `http://127.0.0.1:${port}`
  // Stdio mode exits on pipe EOF if this owner crashes, and drains the database on normal shutdown.
  const child = spawn(cli.command[0], [...cli.command.slice(1), "serve", "--stdio", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_DB: agentDatabaseName }, windowsHide: true, stdio: ["pipe", "ignore", "ignore"],
  })
  let exited = false
  let failure: Error | undefined
  const exit = new Promise<void>((resolve) => {
    child.once("error", (error) => { failure = error; exited = true; resolve() })
    child.once("exit", () => { exited = true; resolve() })
  })
  const stopper = createProcessStopper({
    exit, exited: () => exited, requestStop: () => { child.stdin?.end() }, forceStop: () => { child.kill("SIGKILL") },
    graceMs: 6500, forcedMs: 6500,
  })
  ownPhysicalServer(stopper.stop)
  try {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (exited) throw failure ?? new Error("PHYSICALSYSTEMS_SERVER_EXITED")
      const response = await fetch(url + "/api/info", {
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        signal: AbortSignal.timeout(1000),
      }).catch(() => undefined)
      if (response?.ok) {
        await physical.configureServer(url, password)
        const ready = { url, password }
        SidecarCredentials.set(ready)
        return ready
      }
      await setTimeout(100)
    }
    throw new Error("PHYSICALSYSTEMS_SERVER_START_TIMEOUT")
  } catch (error) { await stopper.stop(); throw error }
}
