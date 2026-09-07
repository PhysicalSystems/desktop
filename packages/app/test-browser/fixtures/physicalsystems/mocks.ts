import { createStore } from "solid-js/store"
import { physicalSystemsEnglish } from "../../../src/physicalsystems/i18n"
import { migrationEnglish } from "../../../src/physicalsystems/migration-i18n"
const english = { ...physicalSystemsEnglish, ...migrationEnglish }
import type { Component } from "solid-js"

export const language = {
  intl: () => "en-US",
  t: (key: string, params: Record<string, unknown> = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      english[key as keyof typeof english] ?? key,
    ),
}
export const useLanguage = () => language
const connection = { type: "http-base", key: "sidecar" }
export const ServerConnection = {
  Key: { make: (key: string) => key },
  key: (value: typeof connection) => value.key,
  builtin: (value: typeof connection) => value.key === "sidecar",
}
export const useServer = () => ({ key: "sidecar", list: [connection] })
export const sessions = { created: [] as unknown[], remembered: [] as string[] }
export const useGlobal = () => ({
  ensureServerCtx: () => ({
    sdk: {
      api: {
        session: {
          async create(input: { agent: string; location: { directory: string } }) {
            sessions.created.push(input)
            return {
              id: `session-created-${sessions.created.length}`,
              title: "Device inspection",
              projectID: "sdk-project",
              location: input.location,
              time: { created: Date.now(), updated: Date.now() },
            }
          },
        },
      },
    },
    sync: { session: { remember: (value: { id: string }) => sessions.remembered.push(value.id) } },
  }),
})
export const [location, setLocation] = createStore({ pathname: "/server/c2lkZWNhcg==/session/session-a" })
export const useLocation = () => location
export const requireServerKey = (segment: string) => atob(segment)
export const useTabs = () => ({
  addSessionTab: (tab: { server: string; sessionId: string }) => tab,
  rememberSessionInfo: () => {},
  select: (tab: { server: string; sessionId: string }) =>
    setLocation("pathname", `/server/${btoa(tab.server)}/session/${tab.sessionId}`),
  newDraft: async () => {
    setLocation("pathname", "/new-session")
    return { draftID: "draft-fixture" }
  },
})
export const Persist = { window: (key: string) => key }
export const persisted = (_key: unknown, store: unknown[]) => [...store, undefined, () => true]
const registry = new Map<string, Component>()
export const ToolRegistry = {
  register: (input: { name: string; render: Component }) => registry.set(input.name, input.render),
  render: (name: string) => registry.get(name),
}
