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
export const sessions = {
  created: [] as { agent: string; location: { directory: string } }[],
  remembered: [] as string[],
}
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
export const navigation = {
  hold: false,
  pending: undefined as string | undefined,
  flush() {
    if (!navigation.pending) return
    setLocation("pathname", navigation.pending)
    navigation.pending = undefined
  },
}
export const useLocation = () => location
export const requireServerKey = (segment: string) => atob(segment)
export const tabKey = (tab: { server: string; sessionId: string }) =>
  `${tab.server}\n/server/${btoa(tab.server)}/session/${tab.sessionId}`
export const [tabInfo, setTabInfo] = createStore<Record<string, { directory?: string; title?: string }>>({
  [tabKey({ server: "sidecar", sessionId: "session-a" })]: { directory: "/fixture/a" },
  [tabKey({ server: "sidecar", sessionId: "session-b" })]: { directory: "/fixture/b" },
})
export const useTabs = () => ({
  info: tabInfo,
  addSessionTab: (tab: { server: string; sessionId: string }) => tab,
  rememberSessionInfo: (tab: { server: string; sessionId: string }, info: { directory: string; title: string }) =>
    setTabInfo(tabKey(tab), info),
  select(tab: { server: string; sessionId: string }) {
    const pathname = `/server/${btoa(tab.server)}/session/${tab.sessionId}`
    if (navigation.hold) {
      navigation.pending = pathname
      return
    }
    setLocation("pathname", pathname)
  },
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
