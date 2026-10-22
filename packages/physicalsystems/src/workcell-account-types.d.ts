// SPDX-License-Identifier: Apache-2.0
export type WorkcellAccountState = {
  revision: number
  status: "signed_out" | "signing_in" | "signed_in" | "unavailable"
  account: { id: string; name: string; email: string } | null
  pending: { userCode: string; verificationUrl: string; expiresAt: string; browserOpened: boolean } | null
  error: string | null
}
export type WorkcellAccountBridge = {
  snapshot(): Promise<WorkcellAccountState>
  refresh(): Promise<WorkcellAccountState>
  signIn(): Promise<WorkcellAccountState>
  cancelSignIn(): Promise<WorkcellAccountState>
  signOut(): Promise<WorkcellAccountState>
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>
  subscribe(listener: (state: WorkcellAccountState) => void): () => void
}
