import type { ConversationAccountBridge } from "../../../physicalsystems/src/conversation-account-types"

export type ConversationRequestResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; status?: number }

export type NativeConversationAccountBridge = Omit<ConversationAccountBridge, "request"> & {
  request(...args: Parameters<ConversationAccountBridge["request"]>): Promise<ConversationRequestResult>
}

/** Error properties do not survive Electron contextBridge; decode after that boundary. */
export function conversationAccountBridge(native: NativeConversationAccountBridge): ConversationAccountBridge {
  return {
    ...native,
    async request(...args) {
      const result = await native.request(...args)
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error, status: result.status })
      return result.value
    },
  }
}
