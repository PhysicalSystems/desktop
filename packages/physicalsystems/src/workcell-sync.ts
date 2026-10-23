// SPDX-License-Identifier: Apache-2.0
import type { WorkcellAccountState } from "./workcell-account-types"
import type { ProjectWorkcellState } from "./workcell-project-types"

type Project = { id: string; name: string }
type Input = {
  account: {
    snapshot(): WorkcellAccountState
    generation(): number
    automaticSyncEnabled(): boolean
    subscribe(listener: () => void): () => void
  }
  projects: {
    snapshot(): Promise<{ projects: Project[] }>
    subscribe(listener: () => void): () => void
  }
  links: { dispatch(request: unknown): Promise<ProjectWorkcellState> }
}

/** Runs in native main, independently of which project or window is open. */
export function createWorkcellSync(input: Input) {
  let disposed = false
  let pending = false
  let running: Promise<void> | undefined
  let owner = ""
  const completed = new Set<string>()
  const attempted = new Map<string, number>()
  const identity = () => {
    const state = input.account.snapshot()
    return input.account.automaticSyncEnabled() && state.status === "signed_in" && state.account
      ? JSON.stringify([state.account.id, input.account.generation()])
      : ""
  }
  async function drain() {
    while (pending && !disposed) {
      pending = false
      const account = identity()
      if (owner !== account) {
        completed.clear()
        attempted.clear()
        owner = account
      }
      if (!account) continue
      const snapshot = await input.projects.snapshot().catch(() => null)
      if (!snapshot || disposed || identity() !== account) continue
      // Limit new registrations/retries per pass; the interval continues a large
      // restored profile without consuming the account API limit in one burst.
      const now = Date.now()
      for (const [id, at] of attempted) if (now - at >= 30_000) attempted.delete(id)
      const projects = snapshot.projects
        .filter((project) => !completed.has(project.id) && !attempted.has(project.id))
        .slice(0, Math.max(0, 20 - attempted.size))
      for (const project of projects) {
        if (disposed || identity() !== account) break
        attempted.set(project.id, Date.now())
        const result = await input.links
          .dispatch({
            operation: "ensure",
            projectId: project.id,
            // Local projects do not have a task field. Do not infer one from chat
            // history, connection details or local filesystem contents.
            metadata: { name: project.name.trim().slice(0, 120), task: "" },
          })
          .catch(() => null)
        if (disposed || identity() !== account) break
        if (result?.status === "linked" || result?.errorCode === "PROJECT_ACCOUNT_MISMATCH") completed.add(project.id)
      }
    }
  }
  function sync() {
    if (disposed) return Promise.resolve()
    pending = true
    if (running) return running
    running = Promise.resolve()
      .then(drain)
      .finally(() => {
        running = undefined
        if (pending && !disposed) void sync()
      })
    return running
  }
  let previousAccount = identity()
  const accountChanged = input.account.subscribe(() => {
    const next = identity()
    if (next === previousAccount) return
    previousAccount = next
    void sync()
  })
  const projectsChanged = input.projects.subscribe(() => {
    void sync()
  })
  const timer = setInterval(() => {
    void sync()
  }, 30_000)
  timer.unref?.()
  void sync()
  return {
    sync,
    dispose() {
      disposed = true
      pending = false
      clearInterval(timer)
      accountChanged()
      projectsChanged()
      completed.clear()
      attempted.clear()
    },
  }
}
