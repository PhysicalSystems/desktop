// SPDX-License-Identifier: Apache-2.0
export type ModelAccountError =
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "SECURE_STORE_UNAVAILABLE"
  | "SESSION_EXPIRED"
  | "ACCESS_REVOKED"
  | "SIGN_IN_EXPIRED"
  | "SIGN_IN_DENIED"
  | "INVALID_SELECTION"
  | "BROWSER_UNAVAILABLE"
export type ModelCompatibility = { runtime: string; platform: string; robotType: string; configurationSha256: string }
export type ModelCompany = { id: string; name: string; role: "owner" | "operator" | "viewer" }
export type CompanyModelRelease = {
  releaseId: string
  modelId: string
  version: string
  manifestSha256: string
  createdAt: string
  compatibility: ModelCompatibility
  evaluation: { kind: "offline" | "supervised"; reportPath: string }
  keyId: string
  signatureVerified: true
}
export type ModelIdentity = { releaseId: string; manifestSha256: string }
export type ModelDevice = {
  id: string
  name: string
  compatibility: ModelCompatibility
  revoked: boolean
  expiresAt: string
  desired: ModelIdentity | null
  staged: ModelIdentity | null
  selected: ModelIdentity | null
  lastReport: { status: "staged" | "selected" | "failed"; createdAt: string; errorCode?: string } | null
}
export type GenericRobotModel = {
  id: string
  name: string
  source: { repoId: string; revision: string }
  kind: "training_base"
  status: "runtime_setup_required"
  architecture: string
  robotCompatibility: "unverified"
  canRun: false
  description: string
}
export type RobotModelSelection =
  | { kind: "company"; companyId: string; releaseId: string; manifestSha256: string }
  | { kind: "generic"; id: string; revision: string }
export type ModelAccountState = {
  revision: number
  status: "signed_out" | "signing_in" | "signed_in" | "unavailable"
  account: { id: string; name: string; email: string } | null
  companies: ModelCompany[]
  companyId: string | null
  releases: CompanyModelRelease[]
  devices: ModelDevice[]
  generic: GenericRobotModel[]
  selection: RobotModelSelection | null
  pending: { userCode: string; verificationUrl: string; expiresAt: string; browserOpened: boolean } | null
  checkedAt: string | null
  error: ModelAccountError | null
}
export type ModelAccountBridge = {
  snapshot(): Promise<ModelAccountState>
  refresh(): Promise<ModelAccountState>
  signIn(): Promise<ModelAccountState>
  cancelSignIn(): Promise<ModelAccountState>
  signOut(): Promise<ModelAccountState>
  company(id: string): Promise<ModelAccountState>
  select(selection: RobotModelSelection | null): Promise<ModelAccountState>
  subscribe(listener: (state: ModelAccountState) => void): () => void
}
