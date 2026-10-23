// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { cloudProfile } from "./profile"
import { permittedRequest, verifiedAgent, verifiedSession } from "./policy"
const env = {
  OPENCODE_SERVER_PASSWORD: "fixture-worker-password-long-enough-123",
  PHYSICALSYSTEMS_AI_API_KEY: "fixture-provider-key",
  CONVERSATION_PROVIDER: "qualification",
  CONVERSATION_MODEL: "fixture-chat",
  CONVERSATION_API_BASE_URL: "http://127.0.0.1:3001/v1",
  CLOUD_WORKSPACE: resolve("fixture-workspace"),
  CLOUD_STATE_DIR: resolve("fixture-state"),
  ANTHROPIC_API_KEY: "must-not-inherit",
  OPENAI_API_KEY: "must-not-inherit",
  OPENCODE_CONFIG_CONTENT: "must-not-inherit",
}
const profile = cloudProfile(env)
const agent = {
  id: "physicalsystems-cloud",
  mode: "primary",
  steps: 4,
  model: { id: profile.model, providerID: profile.provider },
  permissions: [{ action: "*", resource: "*", effect: "deny" }],
  request: { headers: {}, body: {} },
}
test("worker owns a fixed policy and isolated environment without copying provider keys into config", () => {
  expect(profile.config.agents["physicalsystems-cloud"].permissions).toEqual([
    { action: "*", resource: "*", effect: "deny" },
  ])
  expect(JSON.stringify(profile.config)).not.toContain(env.PHYSICALSYSTEMS_AI_API_KEY)
  expect(JSON.stringify(profile.childEnv)).not.toContain("must-not-inherit")
  expect(profile.childEnv.PHYSICALSYSTEMS_AI_API_KEY).toBe(env.PHYSICALSYSTEMS_AI_API_KEY)
  expect(profile.config.plugins).toEqual([])
  expect(profile.config.mcp.servers).toEqual({})
  expect(() => cloudProfile({ ...env, OPENCODE_SERVER_PASSWORD: "short" })).toThrow()
  expect(() => cloudProfile({ ...env, CONVERSATION_API_BASE_URL: "http://public.invalid/v1" })).toThrow()
  expect(() => cloudProfile({ ...env, CONVERSATION_API_BASE_URL: "https://secret@provider.invalid/v1" })).toThrow()
})
test("actual loaded policy fails closed when agent is missing, overridden, permissive or at another location", () => {
  const envelope = { location: { directory: profile.workspace }, data: [agent] }
  expect(verifiedAgent(envelope, profile).data).toEqual([agent])
  for (const data of [
    [],
    [{ ...agent, steps: undefined }],
    [{ ...agent, permissions: [] }],
    [{ ...agent, permissions: [...agent.permissions, { action: "bash", resource: "*", effect: "allow" }] }],
    [{ ...agent, request: { headers: { Authorization: "secret" }, body: {} } }],
    [{ ...agent, model: { id: "other", providerID: profile.provider } }],
    [agent, agent],
  ])
    expect(() => verifiedAgent({ ...envelope, data }, profile)).toThrow("CLOUD_POLICY_UNAVAILABLE")
  expect(() => verifiedAgent({ ...envelope, location: { directory: "/other" } }, profile)).toThrow()
})
test("private listener forwards only fixed agent sessions, text prompts and bounded metadata", () => {
  const url = (path: string) => new URL(path, "http://worker.invalid")
  const session = "/api/session/ses_123"
  const creation = {
    id: "ses_123",
    agent: "physicalsystems-cloud",
    model: { id: profile.model, providerID: profile.provider },
    location: { directory: profile.workspace },
  }
  expect(permittedRequest("POST", url("/api/session"), profile, creation)).toBe(true)
  expect(permittedRequest("POST", url("/api/session"), profile, { ...creation, agent: "build" })).toBe(false)
  expect(
    permittedRequest("POST", url("/api/session"), profile, { ...creation, location: { directory: "/other" } }),
  ).toBe(false)
  expect(permittedRequest("POST", url("/api/session"), profile, { ...creation, parentID: "ses_other" })).toBe(false)
  const prompt = { id: "msg_123", prompt: { text: "Hello" }, delivery: "steer" }
  expect(permittedRequest("POST", url(session + "/prompt"), profile, prompt)).toBe(true)
  expect(
    permittedRequest("POST", url(session + "/prompt"), profile, {
      ...prompt,
      prompt: { text: "Hi", files: ["secret"] },
    }),
  ).toBe(false)
  expect(
    permittedRequest("POST", url(session + "/prompt"), profile, { ...prompt, prompt: { text: "x".repeat(32001) } }),
  ).toBe(false)
  for (const path of [
    "/api/config",
    "/api/session",
    "/api/file",
    "/api/pty",
    session + "/shell",
    session + "/message?limit=201&order=asc",
  ])
    expect(permittedRequest("GET", url(path), profile)).toBe(false)
  expect(permittedRequest("GET", url(session + "/message?order=asc&limit=200"), profile)).toBe(true)
  expect(permittedRequest("GET", url(session + "/message?cursor=opaque&limit=200"), profile)).toBe(true)
  expect(
    permittedRequest(
      "GET",
      url("/api/agent?" + new URLSearchParams({ "location[directory]": profile.workspace })),
      profile,
    ),
  ).toBe(true)
  expect(permittedRequest("GET", url("/api/agent?directory=" + encodeURIComponent(profile.workspace)), profile)).toBe(
    false,
  )
})
test("an adopted old session cannot change the fixed execution binding", () => {
  const data = {
    id: "ses_fixture",
    agent: "physicalsystems-cloud",
    location: { directory: profile.workspace },
    model: { id: profile.model, providerID: profile.provider },
  }
  expect(verifiedSession({ data }, data.id, profile)).toBe(true)
  for (const change of [
    { agent: "build" },
    { id: "ses_other" },
    { location: { directory: "/other" } },
    { location: { directory: profile.workspace, workspaceID: "wrk_other" } },
    { model: { id: "other", providerID: profile.provider } },
  ])
    expect(verifiedSession({ data: { ...data, ...change } }, data.id, profile)).toBe(false)
  expect(verifiedSession({}, data.id, profile)).toBe(false)
})
