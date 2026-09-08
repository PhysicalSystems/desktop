// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"

/** Node actions receive artifact-runtime credentials directly from the runner;
 * shell steps do not. Never export these credentials through GITHUB_ENV. */
export function providerReviewRuntimeCommand(env, platform = process.platform) {
  if (
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !["linux", "win32"].includes(platform) ||
    !isAbsolute(env.RUNNER_TEMP ?? "") ||
    env.RUNNER_OS !== (platform === "linux" ? "Linux" : "Windows") ||
    !["candidate", "public"].includes(env.INPUT_MODE)
  )
    throw Error("PROVIDER_REVIEW_RUNTIME_INVALID")
  if (env.PS_PROVIDER_REVIEW && !["disabled", "openai-device"].includes(env.PS_PROVIDER_REVIEW))
    throw Error("PROVIDER_REVIEW_RUNTIME_INVALID")
  if (
    env.PS_PROVIDER_REVIEW === "openai-device" &&
    platform === "linux" &&
    (!env.ACTIONS_RUNTIME_TOKEN ||
      !env.ACTIONS_RESULTS_URL ||
      !/^[a-f0-9]{40}$/.test(env.PHYSICALSYSTEMS_PROVIDER_REVIEW_SOURCE_SHA ?? "") ||
      !/^[a-f0-9]{64}$/.test(env.PS_PROVIDER_REVIEW_KEY_SHA256 ?? "") ||
      !env.PS_PROVIDER_REVIEW_PUBLIC_KEY_PEM)
  )
    throw Error("PROVIDER_REVIEW_RUNTIME_INVALID")
  const root = join(env.RUNNER_TEMP, "desktop-release")
  const args =
    env.INPUT_MODE === "public"
      ? ["script/desktop-public-smoke.ts"]
      : [
          "script/desktop-release.ts",
          "qualify",
          "--inputs",
          join(root, "inputs", "release-inputs.json"),
          "--artifacts",
          join(root, "artifacts"),
          "--output",
          join(root, "receipts"),
        ]
  return platform === "linux"
    ? { executable: "/usr/bin/xvfb-run", args: ["-a", "bun", ...args] }
    : { executable: "bun", args }
}

async function main() {
  const command = providerReviewRuntimeCommand(process.env)
  const code = await new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd: process.env.GITHUB_WORKSPACE,
      env: process.env,
      shell: false,
      stdio: "inherit",
      timeout: 50 * 60 * 1000,
    })
    child.once("error", () => resolve(1))
    child.once("close", (code) => resolve(code === 0 ? 0 : 1))
  })
  if (code !== 0) throw Error("DESKTOP_QUALIFICATION_FAILED")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("DESKTOP_QUALIFICATION_FAILED\n")
    process.exitCode = 1
  })
}
