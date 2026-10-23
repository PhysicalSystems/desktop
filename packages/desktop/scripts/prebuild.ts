#!/usr/bin/env bun
import { join } from "node:path"

// The fork's reviewed authority code must be built by script/desktop-build-agent.ts.
// Never download a stock OpenCode runtime for a Physical Systems application.
const version = (await Bun.file("../../package.json").json()).version
const resources = join(import.meta.dirname, "../resources")
const binary = join(resources, process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli")
const shipped = await Bun.file(join(resources, "opencode-cli.version")).text().catch(() => "")
if (!await Bun.file(binary).exists() || shipped.trim() !== version)
  throw new Error("Build the owned runtime first: bun ../../script/desktop-build-agent.ts")
