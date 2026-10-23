import { expect, test, type Page } from "@playwright/test"
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
  const settings = page.getByRole("navigation", { name: "Workcells", exact: true }).getByRole("button", {
    name: "Open settings",
    exact: true,
  })
  await expect(settings).toBeEnabled()
  await settings.click()
  await openAppearance(page)

  const dialog = page.locator(".settings-screen")
  const scheme = dialog.locator('[data-action="settings-color-scheme"]')
  await expect(scheme).toContainText("System")
  await scheme.click()
  await page.getByRole("option", { name: "Light", exact: true }).click()
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await expect(scheme).toContainText("Light")
  await page.screenshot({ path: info.outputPath("appearance-light.png") })

  await dialog.getByRole("button", { name: "Back to app", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.reload()
  await expect(settings).toBeEnabled()
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await settings.click()
  await openAppearance(page)
  await expect(scheme).toContainText("Light")
  await scheme.click()
  await page.getByRole("option", { name: "Dark", exact: true }).click()
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
  await expect(scheme).toContainText("Dark")
  await page.screenshot({ path: info.outputPath("appearance-dark.png") })
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
})

test("System follows operating system changes and settings remain available in collapsed sidebar", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto("/")
  const projects = page.getByRole("navigation", { name: "Workcells", exact: true })
  await expect(projects.getByRole("button", { name: "Collapse projects", exact: true })).toBeEnabled()
  const modifier = await page.evaluate(() => (/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"))
  await page.keyboard.press(`${modifier}+,`)
  const dialog = page.locator(".settings-screen")
  await openAppearance(page)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await projects.getByRole("button", { name: "Collapse projects", exact: true }).click()
  await projects.getByRole("button", { name: "Open settings", exact: true }).click()
  await openAppearance(page)

  const scheme = dialog.locator('[data-action="settings-color-scheme"]')
  await expect(scheme).toContainText("System")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
  await expect(scheme).toContainText("System")
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await projects.getByRole("button", { name: "Open settings", exact: true }).click()
  await openAppearance(page)
})

async function openAppearance(page: Page) {
  const settings = page.locator(".settings-screen")
  await expect(settings).toBeVisible()
  const menu = settings.locator(".settings-mobile-menu-trigger")
  if (await menu.isVisible()) {
    await menu.click()
    await page.getByRole("menuitemradio", { name: "Appearance", exact: true }).click()
    return
  }
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click()
}
