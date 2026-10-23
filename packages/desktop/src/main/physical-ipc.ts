import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { app, BrowserWindow, dialog, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { trustedRenderer } from "../../../physicalsystems/src/renderer-authority"
import { createLeLabCameraClient } from "../../../physicalsystems/src/lelab"
import type { LeLabConnection, LeLabFrameRequest } from "../../../physicalsystems/src/lelab-types"
import { previewLegacyImport, commitLegacyImport, listLegacyImports, readLegacyImport } from "../../../physicalsystems/src/migration"
import type { LegacyImportPreview } from "../../../physicalsystems/src/migration"
import type { PhysicalCommand } from "@opencode/app/physicalsystems-types"
import { createDesktopModelAccount } from "./model-account"
import { createDesktopWorkcellAccount } from "./workcell-account"
import { createDesktopConversationAccount } from "./conversation-account"
import { conversationRequestFailure } from "../../../physicalsystems/src/conversation-account"
import type { PhysicalHost } from "./physical"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"

export function registerPhysicalIpc(deps: { physical: PhysicalHost; updater: UpdaterController }) {
  const assertPhysicalSender = (event: IpcMainInvokeEvent) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const url = event.senderFrame?.url
    if (!trustedRenderer({ windowMatches: Boolean(window && window.webContents === event.sender), mainFrame: event.senderFrame === event.sender.mainFrame, url, developmentURL: process.env.ELECTRON_RENDERER_URL, packaged: app.isPackaged })) throw new Error("INVALID_OPERATOR_SENDER")
  }
  const models = createDesktopModelAccount()
  const rooms = createDesktopWorkcellAccount()
  ipcMain.handle("physicalsystems:workcells-snapshot", (event) => { assertPhysicalSender(event); return rooms.snapshot() })
  ipcMain.handle("physicalsystems:workcells-refresh", (event) => { assertPhysicalSender(event); return rooms.refresh() })
  ipcMain.handle("physicalsystems:workcells-sign-in", (event) => { assertPhysicalSender(event); return rooms.signIn() })
  ipcMain.handle("physicalsystems:workcells-cancel-sign-in", (event) => { assertPhysicalSender(event); return rooms.cancelSignIn() })
  ipcMain.handle("physicalsystems:workcells-sign-out", (event) => { assertPhysicalSender(event); return rooms.signOut() })
  ipcMain.handle("physicalsystems:workcells-request", (event, method: unknown, path: unknown, body: unknown) => { assertPhysicalSender(event); return rooms.request(method,path,body) })
  app.once("will-quit", () => rooms.dispose())
  const conversations = createDesktopConversationAccount()
  ipcMain.handle("physicalsystems:conversations-snapshot", (event) => { assertPhysicalSender(event); return conversations.snapshot() })
  ipcMain.handle("physicalsystems:conversations-refresh", (event) => { assertPhysicalSender(event); return conversations.refresh() })
  ipcMain.handle("physicalsystems:conversations-sign-in", (event) => { assertPhysicalSender(event); return conversations.signIn() })
  ipcMain.handle("physicalsystems:conversations-cancel-sign-in", (event) => { assertPhysicalSender(event); return conversations.cancelSignIn() })
  ipcMain.handle("physicalsystems:conversations-sign-out", (event) => { assertPhysicalSender(event); return conversations.signOut() })
  ipcMain.handle("physicalsystems:conversations-request", (event, method: unknown, path: unknown, body: unknown) => {
    assertPhysicalSender(event)
    return conversations.request(method, path, body).then(value => ({ ok: true, value }), conversationRequestFailure)
  })
  app.once("will-quit", () => conversations.dispose())
  ipcMain.handle("physicalsystems:models-snapshot", (event) => { assertPhysicalSender(event); return models.snapshot() })
  ipcMain.handle("physicalsystems:models-refresh", (event) => { assertPhysicalSender(event); return models.refresh() })
  ipcMain.handle("physicalsystems:models-sign-in", (event) => { assertPhysicalSender(event); return models.signIn() })
  ipcMain.handle("physicalsystems:models-cancel-sign-in", (event) => { assertPhysicalSender(event); return models.cancelSignIn() })
  ipcMain.handle("physicalsystems:models-sign-out", (event) => { assertPhysicalSender(event); return models.signOut() })
  ipcMain.handle("physicalsystems:models-company", (event, id: string) => { assertPhysicalSender(event); return models.company(id) })
  ipcMain.handle("physicalsystems:models-select", (event, selection: unknown) => { assertPhysicalSender(event); return models.select(selection) })
  app.once("will-quit", () => models.dispose())
  const lelabClients = new Map<number, { client: ReturnType<typeof createLeLabCameraClient>; clear: () => void }>()
  const lelabClient = (event: IpcMainInvokeEvent) => {
    assertPhysicalSender(event)
    const existing = lelabClients.get(event.sender.id)
    if (existing) return existing.client
    const client = createLeLabCameraClient()
    const clear = () => {
      client.dispose()
      lelabClients.delete(event.sender.id)
      event.sender.removeListener("destroyed", clear)
      event.sender.removeListener("did-start-navigation", navigating)
    }
    const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) clear()
    }
    event.sender.once("destroyed", clear)
    event.sender.on("did-start-navigation", navigating)
    lelabClients.set(event.sender.id, { client, clear })
    return client
  }
  ipcMain.handle("physicalsystems:lelab-discover", (event, input: LeLabConnection) => lelabClient(event).discover(input))
  ipcMain.handle("physicalsystems:lelab-frame", (event, input: LeLabFrameRequest) => lelabClient(event).frame(input))
  ipcMain.handle("physicalsystems:lelab-stop", (event, input: { clientId: string }) => lelabClient(event).stop(input))
  app.once("will-quit", () => { for (const item of lelabClients.values()) item.clear() })
  ipcMain.handle("physicalsystems:snapshot", (event) => {
    assertPhysicalSender(event)
    return deps.physical.snapshot()
  })
  ipcMain.handle("physicalsystems:command", (event, request: PhysicalCommand) => {
    assertPhysicalSender(event)
    if (!request || typeof request !== "object" || typeof request.type !== "string" || Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024) throw new Error("INVALID_OPERATOR_REQUEST")
    return deps.physical.command(request)
  })
  ipcMain.handle("physicalsystems:recover", (event) => { assertPhysicalSender(event); return deps.physical.recover() })
  const imports = new Map<string, { preview: LegacyImportPreview; sender: number; expires: number }>()
  const archiveRoot = join(app.getPath("userData"), "legacy-imports")
  ipcMain.handle("physicalsystems:import-preview", async (event) => {
    assertPhysicalSender(event)
    const window = BrowserWindow.fromWebContents(event.sender)!
    const choice = await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
    if (choice.canceled || choice.filePaths.length !== 1) return null
    const preview = await previewLegacyImport(choice.filePaths[0])
    for (const [id, item] of imports) if (item.sender === event.sender.id || item.expires < Date.now()) imports.delete(id)
    const token = randomUUID()
    imports.set(token, { preview, sender: event.sender.id, expires: Date.now() + 300_000 })
    return { ...preview.summary, token }
  })
  ipcMain.handle("physicalsystems:import-commit", async (event, token: unknown) => {
    assertPhysicalSender(event)
    const pending = typeof token === "string" ? imports.get(token) : undefined
    if (!pending || pending.sender !== event.sender.id || pending.expires < Date.now()) throw new Error("IMPORT_PREVIEW_EXPIRED")
    const result = await commitLegacyImport(pending.preview, archiveRoot)
    imports.delete(token as string)
    return result
  })
  ipcMain.handle("physicalsystems:import-list", async (event) => { assertPhysicalSender(event); return listLegacyImports(archiveRoot) })
  ipcMain.handle("physicalsystems:import-read", async (event, id: unknown) => { assertPhysicalSender(event); if (typeof id !== "string") throw new Error("INVALID_IMPORT_ID"); return readLegacyImport(archiveRoot, id) })
  const subscriptions = createUpdaterSubscriptions()
  app.once("will-quit", subscriptions.clear)
  ipcMain.handle("updater-subscribe", (event) => {
    assertPhysicalSender(event)
    subscriptions.set(event.sender.id, deps.updater.subscribe((state) => {
      if (!event.sender.isDestroyed()) event.sender.send("updater-state", state)
    }))
    event.sender.once("destroyed", () => subscriptions.delete(event.sender.id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => { assertPhysicalSender(event); subscriptions.delete(event.sender.id) })
  ipcMain.handle("updater-check", (event) => { assertPhysicalSender(event); return deps.updater.check() })
  ipcMain.handle("updater-download", (event) => { assertPhysicalSender(event); return deps.updater.download() })
  ipcMain.handle("updater-install", (event) => { assertPhysicalSender(event); return deps.updater.install() })
  ipcMain.handle("updater-recover", (event) => { assertPhysicalSender(event); return deps.updater.recover() })
}
