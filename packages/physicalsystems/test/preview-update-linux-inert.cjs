// SPDX-License-Identifier: Apache-2.0
// Empty, offline Electron engine fixture. No product module is loaded here.
const { app, BrowserWindow, dialog, session } = require("electron")
const fs = require("node:fs")
const path = require("node:path")
if (
  process.platform !== "linux" ||
  process.getuid() === 0 ||
  process.argv.length < 4 ||
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  process.env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
  process.env.PHYSICALSYSTEMS_ALLOW_DEVICES !== "0"
)
  app.exit(1)
// Chromium may retain its own switches in argv; the two authored fixture
// arguments are always last, after the entrypoint.
const plan = JSON.parse(fs.readFileSync(process.argv.at(-2), "utf8"))
const choice = process.argv.at(-1)
if (
  plan.kind !== "inert-linux-native-confirmation" ||
  plan.engineVersion !== process.versions.electron ||
  plan.engine !== fs.realpathSync(process.execPath) ||
  plan.entry !== __filename ||
  plan.runId !== process.env.GITHUB_RUN_ID ||
  !["later", "install"].includes(choice)
)
  app.exit(1)
for (const folder of ["profile", "session"]) {
  const directory = path.join(plan.root, folder + "-" + choice)
  fs.mkdirSync(directory, { mode: 0o700 })
  app.setPath(folder === "profile" ? "userData" : "sessionData", directory)
}
app.setName("Inert native confirmation fixture")
const timeout = setTimeout(() => app.exit(1), 70000)
app
  .whenReady()
  .then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith("data:") }),
    )
    const window = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    await window.loadURL(
      "data:text/html,<title>Inert native confirmation fixture</title><h1>Inert native confirmation fixture</h1>",
    )
    process.stdout.write(JSON.stringify({ event: "ready", engineVersion: process.versions.electron }) + "\n")
    const result = await dialog.showMessageBox(plan.options)
    process.stdout.write(JSON.stringify({ event: "response", response: result.response }) + "\n")
    clearTimeout(timeout)
    app.quit()
  })
  .catch(() => app.exit(1))
