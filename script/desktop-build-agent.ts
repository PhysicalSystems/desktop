// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process"
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

// Build our reviewed runtime, never download a stock OpenCode executable: the
// Physical Systems tool authority boundary is compiled into this fork.
const root = path.resolve(import.meta.dir, "..")
if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform))
  throw new Error("Physical Systems Desktop supports Windows and Linux x64")
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version
if (!/^2\.\d+\.\d+$/.test(version)) throw new Error("Expected a pinned OpenCode 2 release")

// Release preparation has already verified this catalog's digest. V2 embeds a
// source snapshot rather than reading the V1 MODELS_DEV_API_JSON build variable.
if (process.env.MODELS_DEV_API_JSON)
  await copyFile(process.env.MODELS_DEV_API_JSON, path.join(root, "packages/core/src/models-dev/snapshot.txt"))

const result = spawnSync(
  process.execPath,
  ["packages/cli/script/build.ts", `--target=opencode-${process.platform === "win32" ? "windows" : "linux"}-x64-baseline`, "--skip-install", "--skip-web-ui"],
  {
    cwd: root,
    env: { ...process.env, OPENCODE_VERSION: version, OPENCODE_CHANNEL: "dev" },
    stdio: "inherit",
    windowsHide: true,
  },
)
if (result.error) throw result.error
if (result.status !== 0) throw new Error("Physical Systems agent build failed")
const platform = process.platform === "win32" ? "windows" : "linux"
const executable = process.platform === "win32" ? "opencode.exe" : "opencode"
const resources = path.join(root, "packages/desktop/resources")
await mkdir(resources, { recursive: true })
const output = path.join(resources, process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli")
await copyFile(path.join(root, `packages/cli/dist/cli-${platform}-x64-baseline/bin`, executable), output)
if (process.platform !== "win32") await chmod(output, 0o755)
await writeFile(path.join(resources, "opencode-cli.version"), version + "\n")
