// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { physicalEnvironment, physicalPrompt } from "./environment"

test("profile isolates configuration and keys while preserving native display and home", () => {
  const original = { HOME: "/original", DISPLAY: ":1", OPENAI_API_KEY: "secret", OPENCODE_CONFIG: "/installed", OPENCODE_AGENT_TOKEN: "old", PHYSICALSYSTEMS_ALLOW_DEVICES: "0" }
  const env = physicalEnvironment(original, "/isolated")
  expect(original.OPENAI_API_KEY).toBe("secret")
  expect(env.OPENAI_API_KEY).toBeUndefined()
  expect(env.OPENCODE_CONFIG).toBeUndefined()
  expect(env.HOME).toBe("/original")
  expect(env.DISPLAY).toBe(":1")
  expect(env.XDG_DATA_HOME).toBe("/isolated/data")
  expect(env.OPENCODE_PURE).toBe("1")
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
  expect(config.default_agent).toBe("physical-systems")
  expect(config.permission["*"]).toBe("deny")
  expect(config.permission.propose_local_experiment).toBe("allow")
  expect(config.permission.approve_local_experiment).toBeUndefined()
  expect(config.share).toBe("disabled")
  expect(physicalPrompt).toContain("Basic camera preview does not require commissioning")
})

test("relative data directories are rejected", () => {
  expect(() => physicalEnvironment({}, "relative")).toThrow("ABSOLUTE")
})

test("ambient cloud credentials, credential files and tracing exporters cannot enter the isolated provider process", () => {
  const values = Object.fromEntries([
    "GITLAB_TOKEN", "GITHUB_TOKEN", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_BEARER_TOKEN_BEDROCK", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET", "AICORE_SERVICE_KEY", "CLOUDFLARE_API_TOKEN",
    "OTEL_EXPORTER_OTLP_ENDPOINT", "SENTRY_DSN", "CUSTOM_PROVIDER_TOKEN", "CUSTOM_PROVIDER_PASSWORD",
  ].map((key) => [key, "fixture-only-do-not-inherit"]))
  const source: NodeJS.ProcessEnv = { ...values, HOME: "/original", DISPLAY: ":1", SSH_AUTH_SOCK: "/native-agent", DBUS_SESSION_BUS_ADDRESS: "native-keyring", PHYSICALSYSTEMS_ALLOW_DEVICES: "0" }
  const env = physicalEnvironment(source, "/isolated")
  for (const key of Object.keys(values)) expect(env[key]).toBeUndefined()
  expect(env.AWS_EC2_METADATA_DISABLED).toBe("true")
  expect(env.HOME).toBe("/original")
  expect(env.SSH_AUTH_SOCK).toBe("/native-agent")
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("native-keyring")
  expect(source.GITLAB_TOKEN).toBe("fixture-only-do-not-inherit")
})
