import { ipcRenderer } from "electron"
import type { PhysicalSystemsBridge } from "@opencode/app/physicalsystems-types"
import type { UpdaterState } from "@opencode/app/updater"
import type { NativeConversationAccountBridge } from "../shared/conversation-account"
import type { NativeWorkcellAccountBridge } from "../shared/workcell-account"
const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

export const physicalBridge: {
  physicalSystems: Omit<PhysicalSystemsBridge, "conversations" | "rooms"> & {
    conversations: NativeConversationAccountBridge
    rooms: NativeWorkcellAccountBridge
  }
  updater: {
    subscribe(cb: (state: UpdaterState) => void): Promise<() => void>
    check(): Promise<UpdaterState>
    download(): Promise<UpdaterState>
    install(): Promise<void>
    recover(): Promise<UpdaterState>
  }
} = {
  physicalSystems: {
    projectWorkcells: {
      inspect: (projectId) =>
        ipcRenderer.invoke("physicalsystems:project-workcell", { operation: "inspect", projectId }),
      refresh: (projectId) =>
        ipcRenderer.invoke("physicalsystems:project-workcell", { operation: "refresh", projectId }),
      create: (projectId, metadata) =>
        ipcRenderer.invoke("physicalsystems:project-workcell", { operation: "create", projectId, metadata }),
      link: (projectId, workcellId) =>
        ipcRenderer.invoke("physicalsystems:project-workcell", { operation: "link", projectId, workcellId }),
      sync: (projectId, metadata) =>
        ipcRenderer.invoke("physicalsystems:project-workcell", { operation: "sync", projectId, metadata }),
      retry: (projectId) => ipcRenderer.invoke("physicalsystems:project-workcell", { operation: "retry", projectId }),
    },
    conversations: {
      snapshot: () => ipcRenderer.invoke("physicalsystems:conversations-snapshot"),
      refresh: () => ipcRenderer.invoke("physicalsystems:conversations-refresh"),
      signIn: () => ipcRenderer.invoke("physicalsystems:conversations-sign-in"),
      cancelSignIn: () => ipcRenderer.invoke("physicalsystems:conversations-cancel-sign-in"),
      signOut: () => ipcRenderer.invoke("physicalsystems:conversations-sign-out"),
      request: (method, path, body) => ipcRenderer.invoke("physicalsystems:conversations-request", method, path, body),
      subscribe: (listener) => {
        const handler = (_: unknown, state: Parameters<typeof listener>[0]) => listener(state)
        ipcRenderer.on("physicalsystems:conversations-state", handler)
        return () => ipcRenderer.removeListener("physicalsystems:conversations-state", handler)
      },
    },
    rooms: {
      snapshot: () => ipcRenderer.invoke("physicalsystems:workcells-snapshot"),
      refresh: () => ipcRenderer.invoke("physicalsystems:workcells-refresh"),
      signIn: () => ipcRenderer.invoke("physicalsystems:workcells-sign-in"),
      cancelSignIn: () => ipcRenderer.invoke("physicalsystems:workcells-cancel-sign-in"),
      signOut: () => ipcRenderer.invoke("physicalsystems:workcells-sign-out"),
      request: (method, path, body) => ipcRenderer.invoke("physicalsystems:workcells-request", method, path, body),
      subscribe: (listener) => {
        const handler = (_: unknown, state: Parameters<typeof listener>[0]) => listener(state)
        ipcRenderer.on("physicalsystems:workcells-state", handler)
        return () => ipcRenderer.removeListener("physicalsystems:workcells-state", handler)
      },
    },
    models: {
      snapshot: () => ipcRenderer.invoke("physicalsystems:models-snapshot"),
      refresh: () => ipcRenderer.invoke("physicalsystems:models-refresh"),
      signIn: () => ipcRenderer.invoke("physicalsystems:models-sign-in"),
      cancelSignIn: () => ipcRenderer.invoke("physicalsystems:models-cancel-sign-in"),
      signOut: () => ipcRenderer.invoke("physicalsystems:models-sign-out"),
      company: (id) => ipcRenderer.invoke("physicalsystems:models-company", id),
      select: (selection) => ipcRenderer.invoke("physicalsystems:models-select", selection),
      subscribe: (listener) => {
        const handler = (_: unknown, state: Parameters<typeof listener>[0]) => listener(state)
        ipcRenderer.on("physicalsystems:models-state", handler)
        return () => ipcRenderer.removeListener("physicalsystems:models-state", handler)
      },
    },
    lelab: {
      discover: (input) => ipcRenderer.invoke("physicalsystems:lelab-discover", input),
      frame: (input) => ipcRenderer.invoke("physicalsystems:lelab-frame", input),
      stop: (input) => ipcRenderer.invoke("physicalsystems:lelab-stop", input),
    },
    recover: () => ipcRenderer.invoke("physicalsystems:recover"),
    migration: {
      preview: () => ipcRenderer.invoke("physicalsystems:import-preview"),
      commit: (token) => ipcRenderer.invoke("physicalsystems:import-commit", token),
      list: () => ipcRenderer.invoke("physicalsystems:import-list"),
      read: (id) => ipcRenderer.invoke("physicalsystems:import-read", id),
    },
    snapshot: () => ipcRenderer.invoke("physicalsystems:snapshot"),
    command: (request) => ipcRenderer.invoke("physicalsystems:command", request),
    subscribe: (listener) => {
      const handler = (_: unknown, snapshot: Parameters<typeof listener>[0]) => listener(snapshot)
      ipcRenderer.on("physicalsystems:snapshot", handler)
      return () => ipcRenderer.removeListener("physicalsystems:snapshot", handler)
    },
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    download: () => ipcRenderer.invoke("updater-download"),
    install: () => ipcRenderer.invoke("updater-install"),
    recover: () => ipcRenderer.invoke("updater-recover"),
  },
}
