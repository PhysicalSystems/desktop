import type { Page } from "@playwright/test"
import type { PhysicalSnapshot } from "../../src/physicalsystems/types"
import { seed } from "./app"
import { mockOpenCodeServer } from "./mock-server"

/** Empty native workspace with the real signed-out shared navigation boundary. */
export async function mockEmptyPhysicalWorkspace(page: Page) {
  await mockOpenCodeServer(page, {
    provider: { all: [], connected: [], default: {} },
    directory: "C:/physical-settings-fixture",
    project: {
      id: "project-settings-fixture",
      worktree: "C:/physical-settings-fixture",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await seed(page, { settings: { general: { newLayoutDesigns: true } } })
  const snapshot: PhysicalSnapshot = {
    revision: 1,
    serviceId: "settings-fixture",
    activeProjectId: null,
    activeConversationId: null,
    connectionGeneration: 0,
    projects: [],
    conversation: null,
    workcell: null,
    setupReport: null,
    experiments: null,
    activeRuns: [],
    activeCaptures: [],
    activeExperiments: [],
  }
  await page.addInitScript((snapshot) => {
    const account = {
      revision: 1,
      sessionId: null,
      status: "signed_out",
      account: null,
      pending: null,
      error: null,
    }
    Object.defineProperty(window, "api", {
      value: {
        physicalSystems: {
          snapshot: async () => snapshot,
          subscribe: () => () => {},
          command: async () => {
            throw new Error("Appearance settings must not issue physical commands")
          },
          rooms: {
            snapshot: async () => account,
            refresh: async () => account,
            subscribe: () => () => {},
            request: async () => {
              throw new Error("Signed-out appearance settings must not request cloud data")
            },
          },
        },
      },
    })
  }, snapshot)
}
