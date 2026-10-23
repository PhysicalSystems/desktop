import type {
  ConversationAccountBridge,
  ConversationAccountState,
} from "../../../../../physicalsystems/src/conversation-account-types"
import type { ProjectWorkcellBridge, ProjectWorkcellState } from "../../../../../physicalsystems/src/workcell-project-types"

export const cloudAccounts = { calls: [] as string[] }

function account(name: string): ConversationAccountBridge {
  let state: ConversationAccountState = {
    revision: 1,
    sessionId: null,
    status: "signed_out",
    account: null,
    pending: null,
    error: null,
  }
  if (name === "rooms" && (window as typeof window & { __fixtureProjectLink?: boolean }).__fixtureProjectLink) {
    state.status = "signed_in"
    state.account = { id: "fixture-account", name: "Fixture", email: "fixture@example.invalid" }
  }
  const listeners = new Set<(value: ConversationAccountState) => void>()
  const update = (status: "signed_out" | "signing_in") => {
    state = {
      ...state,
      revision: state.revision + 1,
      status,
      pending:
        status === "signing_in"
          ? {
              userCode: "INERT-CLOUD-CODE",
              verificationUrl: "https://physicalsystems.ai/inert-fixture",
              expiresAt: "2099-01-01T00:00:00Z",
              browserOpened: false,
            }
          : null,
    }
    listeners.forEach((listener) => listener(structuredClone(state)))
    return structuredClone(state)
  }
  return {
    snapshot: async () => structuredClone(state),
    refresh: async () => {
      cloudAccounts.calls.push(`${name}:refresh`)
      return structuredClone(state)
    },
    signIn: async () => {
      cloudAccounts.calls.push(`${name}:signIn`)
      return update("signing_in")
    },
    cancelSignIn: async () => update("signed_out"),
    signOut: async () => update("signed_out"),
    request: async () => {
      if (name === "rooms" && state.status === "signed_in") return { workcells: [] }
      throw new Error("Signed-out fixture must not request cloud data")
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const conversationBridge = account("conversations")
export const roomsBridge = account("rooms")

const linkedProject = (): ProjectWorkcellState => ({
  projectId: "project-a", accountId: "fixture-account", status: "linked",
  workcell: { id: "c87f3a09-19ae-471e-87f6-627d6bf18bd5", name: "Confirmed workcell", task: "Inspect connectors.",
    objects: "", volume: "", location: "", metadataRevision: 0, canWrite: true },
})
export const projectWorkcellBridge: ProjectWorkcellBridge = {
  inspect: async () => linkedProject(),
  refresh: async () => ({ ...linkedProject(), status: "pending", workcell: null, pendingOperation: "create",
    pendingMetadata: { name: "Pending workcell", task: "Inspect connectors." }, errorCode: "UNAVAILABLE" }),
  retry: async () => { cloudAccounts.calls.push("project:retry"); return linkedProject() },
  create: async () => { throw new Error("Fixture must retry the saved request") },
  sync: async () => { throw new Error("Fixture must not submit another change") },
  link: async () => { throw new Error("Fixture must not replace the pending link") },
}
