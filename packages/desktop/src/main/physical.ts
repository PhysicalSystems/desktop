// SPDX-License-Identifier: Apache-2.0
import { unlink } from "node:fs/promises"
import { saveAttachment } from "../../../physicalsystems/src/attachment"
import type { DesktopAttachment } from "../../../physicalsystems/src/attachment"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserWindow, safeStorage, utilityProcess } from "electron"
import type { PhysicalCommand, PhysicalSnapshot } from "@opencode-ai/app/physicalsystems-types"
import { createCredentialVault } from "../../../physicalsystems/src/credentials"
import { waitForProcessExit, waitForShutdownStep } from "../../../physicalsystems/src/lifecycle"
import { credentialTrace } from "./credential-trace"
import { providerAccountTrace } from "./provider-account-trace"
import { shutdownTrace } from "./shutdown-trace"

export async function createPhysicalHost(dataDir: string) {
  const spawnWorker = () => utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), "physical-worker.js"), [], {
    serviceName: "Physical Systems operator", stdio: "ignore",
  })
  let child = spawnWorker()
  let recovering: Promise<PhysicalSnapshot> | undefined
  let modelServer: { url: string; password: string } | undefined
  let gatewayURL: string | undefined
  const operatorVault = createCredentialVault(join(dataDir, "operator-credentials.enc"), safeStorage)
  const vault = createCredentialVault(join(dataDir, "provider-credentials.enc"), safeStorage)
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  let last: PhysicalSnapshot | undefined
  let attachment: DesktopAttachment | undefined
  let attachmentQueue = Promise.resolve()
  let attachmentCleanup: Promise<void> | undefined
  let attached = ""
  const attachmentPath = join(dirname(dataDir), "desktop", "runtime-attach.json")
  function updateAttachment() {
    if (!attachment) return
    const project = last?.projects.find((project) => project.id === last?.activeProjectId)
    const next = { ...attachment, directory: project?.cwd, sessionId: last?.conversation?.sessionId }
    const serialized = JSON.stringify(next)
    if (attached === serialized) return
    attached = serialized
    attachmentQueue = attachmentQueue.catch(() => {}).then(() => saveAttachment(attachmentPath, next))
  }
  let exited = false
  let closing: Promise<unknown> | undefined
  let closed = false
  let operatorStopped = false
  function broadcast(snapshot: PhysicalSnapshot) {
    last = snapshot
    updateAttachment()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("physicalsystems:snapshot", snapshot)
    }
  }
  function watch(worker: typeof child) {
    let resolveExit!: () => void
    const exit = new Promise<void>((resolve) => { resolveExit = resolve })
    worker.on("message", (value) => {
      if (worker !== child) return
      if (value?.event === "snapshot") { broadcast(value.snapshot); return }
      if (value?.event === "credential") {
        void (value.vault === "operator" ? operatorVault : vault).request(value.operation, value.payload).then(
          (result) => {
            if (value.vault !== "operator") providerAccountTrace(value.operation, value.payload, result)
            if (value.vault !== "operator" && ["set", "remove"].includes(value.operation)) credentialTrace(safeStorage)
            if (worker === child && !exited) worker.postMessage({ event: "credential-result", id: value.id, result })
          },
          () => { if (worker === child && !exited) worker.postMessage({ event: "credential-result", id: value.id, error: "NATIVE_CREDENTIAL_STORE_UNAVAILABLE" }) },
        )
        return
      }
      const task = pending.get(value?.id)
      if (!task) return
      clearTimeout(task.timer)
      pending.delete(value.id)
      if (value.error) task.reject(new Error(value.error))
      else task.resolve(value.result)
    })
    worker.once("exit", () => {
      resolveExit()
      if (worker !== child) return
      exited = true
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("OPERATOR_SERVICE_UNAVAILABLE")) }
      pending.clear()
      if (last && !operatorStopped) broadcast({ ...last, revision: last.revision + 1, hostUnavailable: true,
        projects: last.projects.map((project) => ({ ...project, connection: { ...project.connection, status: "offline", deviceCount: null, inUseCount: null } })),
        workcell: null })
    })
    return exit
  }
  let workerExit = watch(child)
  function request(method: string, values: Record<string, unknown> = {}, stop = false) {
    if (exited) return Promise.reject(new Error("OPERATOR_SERVICE_UNAVAILABLE"))
    if (!stop && pending.size >= 32) return Promise.reject(new Error("OPERATOR_BUSY"))
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("OPERATOR_REQUEST_UNCONFIRMED")) }, method === "start" ? 15_000 : 6500)
      pending.set(id, { resolve, reject, timer })
      child.postMessage({ id, method, ...values })
    })
  }
  const token = randomUUID() + randomUUID()
  const ready = await request("start", { dataDir, agentToken: token }).catch((error) => { child.kill(); throw error }) as { url: string }
  gatewayURL = ready.url
  process.env.PHYSICALSYSTEMS_AGENT_URL = ready.url
  process.env.PHYSICALSYSTEMS_AGENT_TOKEN = token
  process.env.PHYSICALSYSTEMS_AUTH_URL = ready.url + "/auth"
  return {
    snapshot: () => last ? Promise.resolve(last) : request("snapshot") as Promise<PhysicalSnapshot>,
    async command(command: PhysicalCommand) {
      return await request("command", { request: command }, command.type.endsWith(".stop")) as PhysicalSnapshot
    },
    async configureServer(url: string, password: string) {
      modelServer = { url, password }
      await request("server", { url, password })
      attachment = { schemaVersion: 1, url, username: "opencode", password, pid: process.pid }
      updateAttachment()
    },
    recover() {
      if (recovering) return recovering
      if (!gatewayURL || closing || closed || operatorStopped) return Promise.reject(new Error("OPERATOR_RECOVERY_NOT_AVAILABLE"))
      // Another window may already have recovered this service. An explicit
      // resync returns the trusted current identity without starting it again.
      if (!exited) return request("snapshot") as Promise<PhysicalSnapshot>
      recovering = (async () => {
        child = spawnWorker()
        workerExit = watch(child)
        exited = false
        try {
          const ready = await request("start", { dataDir, agentToken: token, agentPort: Number(new URL(gatewayURL!).port) }) as { url: string }
          if (ready.url !== gatewayURL) throw new Error("OPERATOR_IDENTITY_CHANGED")
          if (modelServer) await request("server", modelServer)
          return await request("snapshot") as PhysicalSnapshot
        } catch (error) { child.kill(); throw error }
      })().finally(() => { recovering = undefined })
      return recovering
    },
    owned: () => !!last && (last.activeRuns.length > 0 || last.activeCaptures.length > 0 || last.activeExperiments.length > 0),
    notify() { if (last) broadcast({ ...last, closeBlocked: true }) },
    close() {
      if (closed) return Promise.resolve()
      if (closing) return closing
      closing = (async () => {
        if (!operatorStopped) {
          shutdownTrace("WORKER_CLOSE_BEFORE")
          await request("close", {}, true)
          shutdownTrace("WORKER_CLOSE_AFTER")
          operatorStopped = true
        }
        shutdownTrace("ATTACHMENT_CLEANUP_BEFORE")
        attachment = undefined
        // Finish queued writes before removing the attachment credential, so a
        // delayed write cannot recreate it after shutdown reports completion.
        attachmentCleanup ??= attachmentQueue.catch(() => {}).then(() => unlink(attachmentPath))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return
            attachmentCleanup = undefined
            throw error
          })
        await waitForShutdownStep(attachmentCleanup, 6500, "ATTACHMENT_CLEANUP_UNCONFIRMED")
        shutdownTrace("ATTACHMENT_CLEANUP_AFTER")
        shutdownTrace("WORKER_EXIT_BEFORE")
        if (!exited) child.postMessage({ id: randomUUID(), method: "exit" })
        await waitForProcessExit(workerExit, 6500)
        shutdownTrace("WORKER_EXIT_AFTER")
        closed = true
      })().finally(() => { closing = undefined })
      return closing
    },
  }
}

export type PhysicalHost = Awaited<ReturnType<typeof createPhysicalHost>>
