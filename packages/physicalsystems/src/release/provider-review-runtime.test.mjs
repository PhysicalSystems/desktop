// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { providerReviewRuntimeCommand } from "../../../../.github/actions/provider-review-runtime/main.mjs"

test("Node action only runs fixed candidate/public commands and never serializes runtime credentials", () => {
  const env = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_TEMP: tmpdir(),
    RUNNER_OS: "Linux",
    INPUT_MODE: "candidate",
    PS_PROVIDER_REVIEW: "disabled",
    ACTIONS_RUNTIME_TOKEN: "PRIVATE-CANARY",
  }
  const command = providerReviewRuntimeCommand(env, "linux")
  expect(command.executable).toBe("/usr/bin/xvfb-run")
  expect(command.args.slice(0, 4)).toEqual(["-a", "bun", "script/desktop-release.ts", "qualify"])
  expect(command.args).toContain(join(tmpdir(), "desktop-release", "inputs", "release-inputs.json"))
  expect(JSON.stringify(command)).not.toContain("PRIVATE")
  expect(providerReviewRuntimeCommand({ ...env, INPUT_MODE: "public" }, "linux").args).toEqual([
    "-a",
    "bun",
    "script/desktop-public-smoke.ts",
  ])
  expect(providerReviewRuntimeCommand({ ...env, RUNNER_OS: "Windows" }, "win32").executable).toBe("bun")
  for (const bad of [
    { CI: "false" },
    { INPUT_MODE: "arbitrary-command" },
    { PS_PROVIDER_REVIEW: "unknown" },
    { PS_PROVIDER_REVIEW: "openai-device" },
  ])
    expect(() => providerReviewRuntimeCommand({ ...env, ...bad }, "linux")).toThrow("PROVIDER_REVIEW_RUNTIME_INVALID")
})

test("both native platforms require encrypted challenge runtime inputs before real sign-in", () => {
  const required = {
    ACTIONS_RUNTIME_TOKEN: "INERT-UPLOAD-CANARY",
    ACTIONS_RESULTS_URL: "https://example.invalid/owned-artifacts",
    PHYSICALSYSTEMS_PROVIDER_REVIEW_SOURCE_SHA: "a".repeat(40),
    PS_PROVIDER_REVIEW_KEY_SHA256: "b".repeat(64),
    PS_PROVIDER_REVIEW_PUBLIC_KEY_PEM: "INERT-KEY-TRANSPORT",
  }
  for (const platform of ["linux", "win32"]) {
    const env = {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_TEMP: tmpdir(),
      RUNNER_OS: platform === "linux" ? "Linux" : "Windows",
      INPUT_MODE: "candidate",
      PS_PROVIDER_REVIEW: "openai-device",
      ...required,
    }
    expect(JSON.stringify(providerReviewRuntimeCommand(env, platform))).not.toContain("INERT-")
    for (const key of Object.keys(required))
      expect(() => providerReviewRuntimeCommand({ ...env, [key]: undefined }, platform)).toThrow(
        "PROVIDER_REVIEW_RUNTIME_INVALID",
      )
    expect(() => providerReviewRuntimeCommand({ ...env, PS_BROWSER_REVIEW: "yes" }, platform)).toThrow(
      "PROVIDER_REVIEW_RUNTIME_INVALID",
    )
    expect(providerReviewRuntimeCommand({ ...env, PS_BROWSER_REVIEW: "1" }, platform)).toBeDefined()
  }
})
