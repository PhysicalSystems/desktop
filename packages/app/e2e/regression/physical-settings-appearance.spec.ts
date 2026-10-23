import { expect, test, type Page } from "@playwright/test"
import { mockEmptyPhysicalWorkspace } from "../utils/physical-workspace"

test.beforeEach(async ({ page }) => {
  await mockEmptyPhysicalWorkspace(page)
})

test("opens Appearance without a project and persists explicit light and dark choices", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Your workcells, together", exact: true })).toBeVisible()
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

test("System follows operating system changes and settings remain available in shared and local collapsed sidebars", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto("/")
  const shared = page.getByRole("navigation", { name: "Workcells", exact: true })
  await expect(shared.getByRole("button", { name: "Collapse projects", exact: true })).toBeEnabled()
  const modifier = await page.evaluate(() => (/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"))
  await page.keyboard.press(`${modifier}+,`)
  const dialog = page.locator(".settings-screen")
  await openAppearance(page)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await shared.getByRole("button", { name: "Collapse projects", exact: true }).click()
  await expect(shared.getByRole("button", { name: "Expand projects", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  )
  await expect(shared.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled()
  await shared.getByRole("button", { name: "Open settings", exact: true }).click()
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
  await shared.getByRole("button", { name: "Local workspace", exact: true }).click()
  const projects = page.getByRole("navigation", { name: "Workcells", exact: true })
  await expect(shared).toHaveCount(0)
  await projects.getByRole("button", { name: "Collapse projects", exact: true }).click()
  await projects.getByRole("button", { name: "Open settings", exact: true }).click()
  await openAppearance(page)
  await expect(scheme).toContainText("System")
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await projects.getByRole("button", { name: "Shared workcells", exact: true }).click()
  await expect(shared.getByRole("button", { name: "Open settings", exact: true })).toBeEnabled()
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
