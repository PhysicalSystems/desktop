import { expect, test } from "@playwright/test"
import type { PhysicalSnapshot } from "../../src/physicalsystems/types"
import { mockOpenCodeServer } from "../utils/mock-server"

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v2",
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
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    Object.defineProperty(window, "api", {
      value: {
        physicalSystems: {
          snapshot: async () => snapshot,
          subscribe: () => () => {},
          command: async () => {
            throw new Error("Appearance settings must not issue physical commands")
          },
        },
      },
    })
  }, snapshot)
})

test("opens Appearance without a project and persists explicit light and dark choices", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/")
  const settings = page.getByRole("navigation", { name: "Projects", exact: true }).getByRole("button", {
    name: "Open settings",
    exact: true,
  })
  await expect(settings).toBeEnabled()
  await settings.click()

  const dialog = page.locator(".settings-v2-dialog")
  await expect(dialog.getByRole("tab", { name: "Appearance", exact: true })).toHaveAttribute("aria-selected", "true")
  const scheme = dialog.locator('[data-action="settings-color-scheme"]')
  await expect(scheme.getByRole("radio", { name: "System", exact: true })).toBeChecked()
  await scheme.getByRole("radio", { name: "Light", exact: true }).check()
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await expect(scheme.getByRole("radio", { name: "Light", exact: true })).toBeChecked()
  await page.screenshot({ path: info.outputPath("appearance-light.png") })

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await page.reload()
  await expect(settings).toBeEnabled()
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await settings.click()
  await expect(scheme.getByRole("radio", { name: "Light", exact: true })).toBeChecked()
  await scheme.getByRole("radio", { name: "Dark", exact: true }).check()
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
  await expect(scheme.getByRole("radio", { name: "Dark", exact: true })).toBeChecked()
  await page.screenshot({ path: info.outputPath("appearance-dark.png") })
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
})

test("System follows operating system changes and settings remain available in collapsed sidebar", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto("/")
  const projects = page.getByRole("navigation", { name: "Projects", exact: true })
  await expect(projects.getByRole("button", { name: "Collapse projects", exact: true })).toBeEnabled()
  const modifier = await page.evaluate(() => (/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"))
  await page.keyboard.press(`${modifier}+,`)
  const dialog = page.locator(".settings-v2-dialog")
  await expect(dialog.getByRole("tab", { name: "Appearance", exact: true })).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await projects.getByRole("button", { name: "Collapse projects", exact: true }).click()
  await projects.getByRole("button", { name: "Open settings", exact: true }).click()

  const scheme = dialog.locator('[data-action="settings-color-scheme"]')
  await expect(scheme.getByRole("radio", { name: "System", exact: true })).toBeChecked()
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
  await expect(scheme.getByRole("radio", { name: "System", exact: true })).toBeChecked()
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await projects.getByRole("button", { name: "Open settings", exact: true }).click()
  await expect(dialog.getByRole("tab", { name: "Appearance", exact: true })).toHaveAttribute("aria-selected", "true")
})
