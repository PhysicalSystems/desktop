// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, join } from "node:path"

export function cloudProfile(env: Record<string, string | undefined>) {
  const required = (key: string) => {
    const value = env[key]?.trim()
    if (!value) throw new Error(`Missing ${key}`)
    return value
  }
  const password = required("OPENCODE_SERVER_PASSWORD")
  if (password.length < 32) throw new Error("OPENCODE_SERVER_PASSWORD must contain at least 32 characters")
  const key = required("PHYSICALSYSTEMS_AI_API_KEY")
  const provider = required("CONVERSATION_PROVIDER")
  const model = required("CONVERSATION_MODEL")
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(provider) || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(model))
    throw new Error("Invalid model or provider identifier")
  const endpoint = new URL(required("CONVERSATION_API_BASE_URL"))
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname)))
  )
    throw new Error("Provider endpoint must use HTTPS (loopback HTTP is allowed for qualification)")
  const workspace = env.CLOUD_WORKSPACE ?? "/workspace"
  const state = env.CLOUD_STATE_DIR ?? "/state"
  if (!isAbsolute(workspace) || !isAbsolute(state) || workspace === state)
    throw new Error("Dedicated absolute workspace and state paths required")
  const integer = (key: string, fallback: number, maximum: number) => {
    const value = Number(env[key] ?? fallback)
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${key}`)
    return value
  }
  const port = integer("PORT", 4096, 65535)
  const config = {
    model: `${provider}/${model}`,
    default_agent: "physicalsystems-cloud",
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
    agents: {
      "physicalsystems-cloud": {
        mode: "primary",
        model: `${provider}/${model}`,
        steps: 4,
        system:
          "You are the Physical Systems workcell assistant. Help the user understand and plan their task. You have no tools, access to local files, live robot telemetry, or robot control. Distinguish supplied workcell context from observed facts. Do not claim actions were performed.",
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      },
      build: { disabled: true },
      plan: { disabled: true },
      general: { disabled: true },
      explore: { disabled: true },
    },
    providers: {
      [provider]: {
        name: "Physical Systems cloud model",
        env: ["PHYSICALSYSTEMS_AI_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: endpoint.href.replace(/\/$/, "") },
        models: {
          [model]: {
            name: model,
            capabilities: { tools: false, input: ["text"], output: ["text"] },
            limit: {
              context: integer("CONVERSATION_CONTEXT_TOKENS", 32768, 2000000),
              output: integer("CONVERSATION_OUTPUT_TOKENS", 4096, 32768),
            },
          },
        },
      },
    },
    share: "disabled",
    autoupdate: false,
    snapshots: false,
    lsp: false,
    formatter: false,
    plugins: [],
    mcp: { servers: {} },
    skills: [],
    commands: {},
    instructions: [],
  }
  // An allowlist deliberately excludes inherited provider keys, auth files, plugins and local app state.
  const childEnv: Record<string, string> = {
    PATH: env.PATH ?? "",
    ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
    HOME: join(state, "home"),
    USERPROFILE: join(state, "home"),
    XDG_CONFIG_HOME: join(state, "config"),
    XDG_DATA_HOME: join(state, "data"),
    XDG_CACHE_HOME: join(state, "cache"),
    XDG_STATE_HOME: join(state, "state"),
    TMPDIR: join(state, "tmp"),
    TEMP: join(state, "tmp"),
    TMP: join(state, "tmp"),
    OPENCODE_TEST_HOME: join(state, "home"),
    OPENCODE_CONFIG_DIR: workspace,
    OPENCODE_DB: join(state, "conversations.sqlite"),
    OPENCODE_MODELS_PATH: join(workspace, "models.json"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PASSWORD: password,
    PHYSICALSYSTEMS_AI_API_KEY: key,
  }
  return { workspace, state, port, provider, model, config, childEnv }
}
