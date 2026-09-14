// SPDX-License-Identifier: Apache-2.0
// Early hosted-CI coverage of the real Electron GTK dialog, without the product.
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DESKTOP_NATIVE_ENGLISH, formatDesktopNativeMessage } from "../../app/src/i18n/desktop-native.ts"
import { requireDisposablePublicRunner } from "../src/release/public-qualification.ts"

const env = process.env
if (
  process.argv.length !== 2 ||
  process.platform !== "linux" ||
  process.arch !== "x64" ||
  process.getuid() === 0 ||
  env.CI !== "true" ||
  env.GITHUB_ACTIONS !== "true" ||
  env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  env.RUNNER_OS !== "Linux" ||
  env.RUNNER_ARCH !== "X64" ||
  env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
  env.PHYSICALSYSTEMS_ALLOW_DEVICES !== "0" ||
  !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID || "") ||
  !env.RUNNER_TEMP?.startsWith("/") ||
  !env.DISPLAY ||
  !env.DBUS_SESSION_BUS_ADDRESS
)
  throw Error("INERT_DIALOG_REQUIRES_DISPOSABLE_LINUX")

const root = join(await realpath(env.RUNNER_TEMP), "preview-update-linux-inert")
await mkdir(root, { mode: 0o700 }) // Reuse is refused, including symlinks.
await requireDisposablePublicRunner(env, root)
await writeFile(
  join(root, "owner.json"),
  JSON.stringify({ kind: "inert-linux-native-confirmation", runId: env.GITHUB_RUN_ID }),
  { flag: "wx", mode: 0o600 },
)
const resultPath = join(root, "result.json")
const receipt = {
  kind: "inert-linux-native-confirmation",
  status: "RUNNING",
  choices: [],
  productLaunched: false,
  installerLaunched: false,
}
await writeFile(resultPath, JSON.stringify(receipt), { flag: "wx", mode: 0o600 })
try {
  const directory = dirname(fileURLToPath(import.meta.url))
  const desktop = join(directory, "../../desktop")
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve("electron/package.json", { paths: [desktop] })
  const [manifest, product] = await Promise.all([
    readFile(manifestPath, "utf8").then(JSON.parse),
    readFile(join(desktop, "package.json"), "utf8").then(JSON.parse),
  ])
  const engineDirectory = await realpath(join(dirname(manifestPath), "dist"))
  const engine = join(engineDirectory, "electron")
  const information = await lstat(engine)
  const engineVersion = (await readFile(join(engineDirectory, "version"), "utf8")).trim()
  if (
    manifest.version !== "42.3.3" ||
    product.devDependencies.electron !== manifest.version ||
    engineVersion !== manifest.version ||
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.uid !== process.getuid() ||
    information.size < 1000000
  )
    throw Error("INERT_DIALOG_ELECTRON_PIN_MISMATCH")
  // setup-desktop-build performs the normal pinned electron/install.js download
  // after the frozen dependency install. This fixture never downloads an engine.
  const version = "0.1.0-beta.7"
  const text = (key) => formatDesktopNativeMessage(DESKTOP_NATIVE_ENGLISH[key], { version })
  const plan = {
    kind: receipt.kind,
    root,
    runId: env.GITHUB_RUN_ID,
    engine,
    engineVersion,
    version,
    entry: join(directory, "preview-update-linux-inert.cjs"),
    options: {
      type: "question",
      title: text("desktop.updater.dialog.ready.title"),
      message: text("desktop.updater.preview.confirm"),
      detail: text("desktop.updater.preview.linux"),
      buttons: [text("desktop.updater.preview.install"), text("desktop.updater.dialog.later")],
      defaultId: 1,
      cancelId: 1,
    },
  }
  const planPath = join(root, "plan.json")
  await writeFile(planPath, JSON.stringify(plan), { flag: "wx", mode: 0o600 })
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      ["-I", "-B", "-u", join(directory, "preview-update-linux-inert.py"), planPath],
      {
        cwd: root,
        env,
        shell: false,
        stdio: ["ignore", "inherit", "inherit"],
      },
    )
    child.once("error", () => reject(Error("INERT_DIALOG_HELPER_START_FAILED")))
    child.once("close", (code) => resolve(code))
  })
  const result = JSON.parse(await readFile(resultPath, "utf8"))
  if (code !== 0 || result.status !== "PASS") {
    if (result.status !== "FAIL")
      await writeFile(resultPath, JSON.stringify({ ...result, status: "FAIL", code: "INERT_DIALOG_HELPER_FAILED" }), {
        mode: 0o600,
      })
    process.exitCode = 1
  }
} catch (error) {
  const code =
    typeof error?.message === "string" && /^INERT_DIALOG_[A-Z_]+$/.test(error.message)
      ? error.message
      : "INERT_DIALOG_FIXTURE_FAILED"
  await writeFile(resultPath, JSON.stringify({ ...receipt, status: "FAIL", code }), { mode: 0o600 })
  process.exitCode = 1
}
