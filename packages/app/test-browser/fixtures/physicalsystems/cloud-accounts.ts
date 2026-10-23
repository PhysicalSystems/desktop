import type {
  ConversationAccountBridge,
  ConversationAccountState,
} from "../../../../../physicalsystems/src/conversation-account-types"

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
