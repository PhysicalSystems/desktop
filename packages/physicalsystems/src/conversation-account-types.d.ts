// SPDX-License-Identifier: Apache-2.0
export type ConversationAccountState = {
  revision: number
  /** Public grant identifier used to scope UI recovery; never a bearer credential. */
  sessionId: string | null
  status: "signed_out" | "signing_in" | "signed_in" | "unavailable"
  account: { id: string; name: string; email: string } | null
  pending: { userCode: string; verificationUrl: string; expiresAt: string; browserOpened: boolean } | null
  error: string | null
}
export type ConversationAccountBridge = {
  snapshot(): Promise<ConversationAccountState>
  refresh(): Promise<ConversationAccountState>
  signIn(): Promise<ConversationAccountState>
  cancelSignIn(): Promise<ConversationAccountState>
  signOut(): Promise<ConversationAccountState>
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>
  subscribe(listener: (state: ConversationAccountState) => void): () => void
}
