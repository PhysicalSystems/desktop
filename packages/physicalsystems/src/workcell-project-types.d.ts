// SPDX-License-Identifier: Apache-2.0
export type ProjectWorkcellMetadata = {
  name: string
  task: string
  objects?: string
  volume?: string
  location?: string
}
export type ProjectWorkcellSummary = Required<ProjectWorkcellMetadata> & {
  id: string
  metadataRevision: number
  canWrite: boolean
}
export type ProjectWorkcellState = {
  projectId: string
  accountId: string | null
  status: "signed_out" | "local" | "linked" | "pending" | "conflict" | "unavailable"
  workcell: ProjectWorkcellSummary | null
  pendingMetadata?: ProjectWorkcellMetadata
  pendingOperation?: "create" | "sync"
  errorCode?: string
}
export type ProjectWorkcellBridge = {
  inspect(projectId: string): Promise<ProjectWorkcellState>
  refresh(projectId: string): Promise<ProjectWorkcellState>
  create(projectId: string, metadata: ProjectWorkcellMetadata): Promise<ProjectWorkcellState>
  link(projectId: string, workcellId: string): Promise<ProjectWorkcellState>
  sync(projectId: string, metadata: ProjectWorkcellMetadata): Promise<ProjectWorkcellState>
  retry(projectId: string): Promise<ProjectWorkcellState>
}
