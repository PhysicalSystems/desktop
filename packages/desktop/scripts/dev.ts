import { $ } from "bun"
import { fileURLToPath } from "node:url"

// Development exercises the same reviewed, privately scoped runtime as packaged builds.
if (process.argv.includes("--download-server")) throw new Error("Stock OpenCode runtimes are not supported")
await $`bun ../../script/desktop-build-agent.ts`
process.env.OPENCODE_CHANNEL = "dev"
process.exitCode = await Bun.spawn(
  ["node", fileURLToPath(new URL("../bin/electron-vite.js", import.meta.resolve("electron-vite"))), "dev", ...process.argv.slice(2)],
  { env: process.env, stdio: ["inherit", "inherit", "inherit"] },
).exited
