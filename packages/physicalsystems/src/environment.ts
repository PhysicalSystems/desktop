// SPDX-License-Identifier: Apache-2.0
import { join, isAbsolute } from "node:path"

const tools = ["inspect_physical_system", "plan_physical_workflow", "inspect_physical_capabilities", "preview_physical_capability", "read_agent_skill", "inspect_physical_execution", "inspect_physical_setup", "inspect_local_experiment", "propose_local_experiment", "run_simulated_trial", "finish_local_experiment", "question"]

export const physicalPrompt = `You are Physical Systems, an assistant for investigating physical systems with an operator.
Use the reviewed tools to inspect available devices, explain every relevant missing prerequisite, and propose useful approaches.
Basic camera preview does not require commissioning. Direct the operator to the Devices panel (/workcell in the legacy client); only the operator starts preview. Preview does not provide you with vision.
Read the reviewed inspect-workcell or transfer-container skill when relevant. Skills grant no execution authority.
The local experiment is a numeric synthetic fixture, not a robot, physics simulator, camera, or learned policy. Clearly label its evidence synthetic.
Propose a bounded experiment and let the inline approval card present the exact plan. Never claim approval based on chat prose or a generic permission prompt. After approval, inspect the current recorded state and run only permitted remaining trials, adjusting from measured evidence. Finish and summarize recorded results without claiming physical qualification.
Physical execution, commissioning, and new hardware capabilities are not granted by adopting this agent. If configuration or support is missing, explain the concrete blocker and supported next step. Never invent device status or successful outcomes.`

/** A separate app profile: never inherit the installed product's config or keys. */
export function physicalEnvironment(input: NodeJS.ProcessEnv, root: string) {
  if (!isAbsolute(root)) throw new Error("PHYSICALSYSTEMS_DATA_DIR_MUST_BE_ABSOLUTE")
  const result = { ...input }
  for (const key of Object.keys(result)) {
    if (key.startsWith("OPENCODE_") || /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PROFILE)/.test(key) || /^(?:AWS|AZURE|GOOGLE|GCP|CLOUDFLARE|ANTHROPIC|OPENAI|GEMINI|GITLAB|GITHUB|OTEL|SENTRY)_/.test(key)) delete result[key]
  }
  const permission = { "*": "deny", ...Object.fromEntries(tools.map((name) => [name, "allow"])) }
  const config = {
    default_agent: "physical-systems", autoupdate: false, share: "disabled", plugin: [], mcp: {},
    permission,
    agent: {
      build: { disable: true }, plan: { disable: true }, general: { disable: true }, explore: { disable: true },
      "physical-systems": { mode: "primary", description: "Inspect, plan and compare physical-system investigations", prompt: physicalPrompt, permission },
    },
  }
  return Object.assign(result, {
    PHYSICALSYSTEMS_DESKTOP: "1", PHYSICALSYSTEMS_DATA_DIR: root,
    XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    AWS_EC2_METADATA_DISABLED: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    OPENCODE_PURE: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  })
}
