// SPDX-License-Identifier: Apache-2.0
// This projection is deliberately public-safe. Never retain transcript text,
// model arguments, provider responses, connection URLs, IDs or runtime tokens.
export function fixtureCheckpointDetail(input: { calls: unknown; renderer: unknown }) {
  const calls = Array.isArray(input.calls) ? input.calls : []
  const count = (value: number) => Math.min(Math.max(Number.isSafeInteger(value) ? value : 0, 0), 10000)
  const tools = (name: string) =>
    count(calls.filter((value) => value && typeof value === "object" && value.tool === name).length)
  const renderer =
    input.renderer && typeof input.renderer === "object" && !Array.isArray(input.renderer)
      ? (input.renderer as Record<string, unknown>)
      : {}
  const yes = (name: string) => renderer[name] === true
  const phase = ["PROPOSED", "READY", "MEASURING", "RUNNING", "COMPLETED", "FINISHED", "STOPPED", "FAILED"].includes(
    String(renderer.phase),
  )
    ? String(renderer.phase)
    : "NONE_OR_UNKNOWN"
  return (
    "Synthetic fixture checkpoint: " +
    JSON.stringify({
      providerResponses: count(calls.length),
      inspectResponses: tools("inspect_local_experiment"),
      proposalResponses: tools("propose_local_experiment"),
      trialResponses: tools("run_simulated_trial"),
      rendererObserved: yes("observed"),
      projectSelected: yes("projectSelected"),
      conversationBound: yes("conversationBound"),
      hostUnavailable: yes("hostUnavailable"),
      experimentError: yes("experimentError"),
      phase,
      approvalVisible: yes("approvalVisible"),
      userMessages: count(Number(renderer.userMessages)),
      alerts: count(Number(renderer.alerts)),
    })
  )
}
