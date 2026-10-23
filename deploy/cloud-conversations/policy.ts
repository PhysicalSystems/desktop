// SPDX-License-Identifier: Apache-2.0
type Policy = { workspace: string; provider: string; model: string }
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value))

/** A configured name on a Session is insufficient: missing agents otherwise advertise all tools. */
export function verifiedAgent(value: unknown, policy: Policy) {
  if (
    !record(value) ||
    !record(value.location) ||
    value.location.directory !== policy.workspace ||
    !Array.isArray(value.data)
  )
    throw new Error("CLOUD_POLICY_UNAVAILABLE")
  const agents = value.data.filter((item) => record(item) && item.id === "physicalsystems-cloud")
  if (agents.length !== 1) throw new Error("CLOUD_POLICY_UNAVAILABLE")
  const agent = agents[0] as Record<string, unknown>
  if (
    agent.mode !== "primary" ||
    agent.steps !== 4 ||
    !record(agent.model) ||
    agent.model.id !== policy.model ||
    agent.model.providerID !== policy.provider ||
    !record(agent.request) ||
    !record(agent.request.headers) ||
    Object.keys(agent.request.headers).length !== 0 ||
    !record(agent.request.body) ||
    Object.keys(agent.request.body).length !== 0 ||
    !Array.isArray(agent.permissions) ||
    agent.permissions.length === 0 ||
    agent.permissions.some((rule) => !record(rule) || rule.effect !== "deny") ||
    !agent.permissions.some(
      (rule) => record(rule) && rule.action === "*" && rule.resource === "*" && rule.effect === "deny",
    )
  )
    throw new Error("CLOUD_POLICY_UNAVAILABLE")
  return { ...value, data: [agent] }
}

/** Engine health precedes asynchronous plugin initialization; never expose the listener during this gap. */
export async function awaitVerifiedAgent(
  read: () => Promise<unknown>,
  policy: Policy,
  options: { alive: () => boolean; timeoutMs?: number; intervalMs?: number },
) {
  const deadline = Date.now() + (options.timeoutMs ?? 120000)
  while (true) {
    if (!options.alive()) throw new Error("CLOUD_WORKER_EXITED")
    const agent = await read()
      .then((value) => verifiedAgent(value, policy))
      .catch(() => undefined)
    if (!options.alive()) throw new Error("CLOUD_WORKER_EXITED")
    if (agent) return agent
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("CLOUD_POLICY_UNAVAILABLE")
    await Bun.sleep(Math.min(options.intervalMs ?? 200, remaining))
  }
}

export function verifiedSession(value: unknown, id: string, policy: Policy) {
  if (!record(value) || !record(value.data)) return false
  const session = value.data
  return (
    session.id === id &&
    session.agent === "physicalsystems-cloud" &&
    record(session.model) &&
    session.model.id === policy.model &&
    session.model.providerID === policy.provider &&
    record(session.location) &&
    session.location.directory === policy.workspace &&
    !session.location.workspaceID
  )
}

export function permittedRequest(method: string, url: URL, policy: Policy, body?: unknown) {
  const session = "/api/session/ses_[A-Za-z0-9_-]{1,100}"
  if (method === "GET") {
    if (["/api/health", "/api/session/active"].includes(url.pathname) && !url.search) return true
    if (
      url.pathname === "/api/agent" &&
      [...url.searchParams.keys()].join() === "location[directory]" &&
      url.searchParams.get("location[directory]") === policy.workspace
    )
      return true
    if (new RegExp(`^${session}$`).test(url.pathname) && !url.search) return true
    if (new RegExp(`^${session}/message$`).test(url.pathname)) {
      const keys = [...url.searchParams.keys()].sort().join()
      return (
        url.searchParams.get("limit") === "200" &&
        ((keys === "limit,order" && url.searchParams.get("order") === "asc") ||
          (keys === "cursor,limit" && Boolean(url.searchParams.get("cursor")) && url.search.length <= 2000))
      )
    }
    return false
  }
  if (method !== "POST" || url.search || !record(body)) return false
  if (url.pathname === "/api/session")
    return (
      Object.keys(body).sort().join() === "agent,id,location,model" &&
      typeof body.id === "string" &&
      /^ses_[A-Za-z0-9_-]{1,100}$/.test(body.id) &&
      body.agent === "physicalsystems-cloud" &&
      record(body.location) &&
      Object.keys(body.location).join() === "directory" &&
      body.location.directory === policy.workspace &&
      record(body.model) &&
      Object.keys(body.model).sort().join() === "id,providerID" &&
      body.model.id === policy.model &&
      body.model.providerID === policy.provider
    )
  return (
    new RegExp(`^${session}/prompt$`).test(url.pathname) &&
    Object.keys(body).sort().join() === "delivery,id,prompt" &&
    typeof body.id === "string" &&
    /^msg_[A-Za-z0-9_-]{1,100}$/.test(body.id) &&
    body.delivery === "steer" &&
    record(body.prompt) &&
    Object.keys(body.prompt).join() === "text" &&
    typeof body.prompt.text === "string" &&
    body.prompt.text.trim().length > 0 &&
    body.prompt.text.length <= 32000
  )
}
