// SPDX-License-Identifier: Apache-2.0
import type { PhysicalProject } from "./types"

/** Creates local conversation records only. A failed binding retry reuses its known session. */
export function createConversationStarter<T extends { id: string; title: string }>(actions: {
  create(project: PhysicalProject, serverId: string): Promise<T>
  bind(project: PhysicalProject, serverId: string, session: T): Promise<boolean>
}) {
  const created = new Map<string, T>()
  const pending = new Map<string, Promise<T | undefined>>()
  return (project: PhysicalProject, serverId: string) => {
    const key = JSON.stringify([project.id, serverId])
    const existing = pending.get(key)
    if (existing) return existing
    const operation = (async () => {
      const session = created.get(key) ?? (await actions.create(project, serverId))
      created.set(key, session)
      if (!(await actions.bind(project, serverId, session))) return
      created.delete(key)
      return session
    })().finally(() => pending.delete(key))
    pending.set(key, operation)
    return operation
  }
}
