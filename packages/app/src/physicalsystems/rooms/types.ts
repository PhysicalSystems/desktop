// SPDX-License-Identifier: Apache-2.0
export type WorkcellMessage = {
  id: string
  workcellId: string
  sequence: number
  role: "user" | "system"
  authorId: string | null
  authorName: string
  content: string
  createdAt: string
}
export type WorkcellRoomData = {
  id: string
  name: string
  task: string
  objects: string
  volume: string
  location: string
  companyId: string | null
  companyName: string | null
  status: string
  setupStage: string
  createdAt: string
  updatedAt: string
  version: number
  lastEventSequence: number
  setupStages: { id: string; label: string; status: "complete" | "pending"; detail: string }[]
  robot: { status: string; deviceId: string | null }
  telemetry: { status: string; observedAt: string | null; metrics: unknown; reason: string }
  permissions: { canRead: boolean; canPost: boolean }
  messages: WorkcellMessage[]
  messagesHasMore: boolean
  resources: {
    scope: "company" | "personal"
    services: {
      id: string
      workstation: string
      status: string
      monthlyCents: number
      currency: string
      href: string
    }[]
    models: { releaseId: string; modelId: string; version: string; createdAt: string; href: string }[]
    links: { pilots: string; services: string; credits: string; computeBilling: string; models: string }
  }
}
export type WorkcellEventPage = {
  events: { id: string; sequence: number; type: string; message?: WorkcellMessage }[]
  nextCursor: number
  hasMore: boolean
  lastEventSequence: number
}
export type WorkcellTransport = {
  request(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>
}
export type WorkcellRoomOptions = {
  workcellId: string
  transport: WorkcellTransport
  theme?: "light" | "dark"
  navigate?(href: string): void
  onPrepareTask?(room: WorkcellRoomData): void | Promise<void>
}
