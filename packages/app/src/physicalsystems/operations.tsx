// SPDX-License-Identifier: Apache-2.0
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "../context/language"
import { usePhysicalSystems } from "./context"
import type { PhysicalCommand } from "./types"
import { Phase } from "./experiments"

/** Mounted above ConnectionGate and routing, so model/server health cannot hide Stop. */
export function PhysicalOperations() {
  const physical = usePhysicalSystems()
  const language = useLanguage()
  const operations = createMemo(() => {
    const snapshot = physical?.state.snapshot
    if (!snapshot) return []
    return [
      ...(snapshot.activeCommissioning ?? []).map((owner) => ({
        key: `commissioning:${owner.projectId}:${owner.trialId ?? "pending"}`,
        owner: { ...owner, canStop: owner.canStop && !!owner.trialId },
        label: language.t("physicalsystems.commissioning.title"),
        phase:
          owner.status?.trial?.phase === "OUTCOME_UNKNOWN"
            ? "OUTCOME_UNKNOWN"
            : (owner.status?.trial?.stopStatus ?? owner.status?.trial?.phase ?? "OUTCOME_UNKNOWN"),
        command: {
          type: "workcell.commissioning.stop",
          projectId: owner.projectId,
          conversationId: owner.conversationId!,
          serverId: owner.serverId,
          sessionId: owner.sessionId,
          connectionGeneration: owner.connectionGeneration,
          trialId: owner.trialId!,
          reason: "operator-requested-stop",
        } as PhysicalCommand,
      })),
      ...snapshot.activeCaptures.map((owner) => ({
        key: `capture:${owner.projectId}:${owner.captureSessionId ?? "pending"}`,
        owner,
        label: language.t("physicalsystems.operations.capture"),
        phase: owner.stopUnconfirmed ? "STOP_UNCONFIRMED" : owner.stopPending ? "STOPPING" : "",
        command: {
          type: "workcell.camera.stop",
          projectId: owner.projectId,
          conversationId: owner.conversationId,
          serverId: owner.serverId,
          sessionId: owner.sessionId,
          connectionGeneration: owner.connectionGeneration,
          expectedCaptureSessionId: owner.captureSessionId ?? null,
        } as PhysicalCommand,
      })),
      ...snapshot.activeRuns.map((owner) => ({
        key: `run:${owner.projectId}:${owner.run.runId}`,
        owner,
        label: language.t("physicalsystems.operations.run"),
        phase: owner.run.stopStatus ?? owner.run.phase,
        command: {
          type: "workcell.execution.stop",
          projectId: owner.projectId,
          conversationId: owner.conversationId,
          serverId: owner.serverId,
          sessionId: owner.sessionId,
          connectionGeneration: owner.connectionGeneration,
          runId: owner.run.runId,
          reason: "operator-requested-stop",
        } as PhysicalCommand,
      })),
      ...snapshot.activeExperiments.map((owner) => ({
        key: `experiment:${owner.projectId}:${owner.experiment.id}`,
        owner,
        label: language.t("physicalsystems.operations.experiment"),
        phase: owner.experiment.phase,
        command: {
          type: "experiment.stop",
          projectId: owner.projectId,
          conversationId: owner.conversationId!,
          serverId: owner.serverId,
          sessionId: owner.sessionId,
          connectionGeneration: owner.connectionGeneration,
          experimentId: owner.experiment.id,
        } as PhysicalCommand,
      })),
    ]
  })
  return (
    <Show
      when={
        physical?.enabled &&
        (operations().length ||
          physical.state.snapshot?.closeBlocked ||
          physical.state.unavailable ||
          physical.state.snapshot?.hostUnavailable)
      }
    >
      <aside class="ps-operations" aria-label={language.t("physicalsystems.operations")} data-ps-operations>
        <Show when={physical?.state.unavailable || physical?.state.snapshot?.hostUnavailable}>
          <div class="ps-operation">
            <p role="status">{language.t("physicalsystems.connection.unavailable")}</p>
            <Show when={physical?.canRecover}>
              <button
                type="button"
                data-ps-recover
                disabled={physical?.state.pending.recover}
                onClick={() => void physical?.recover()}
              >
                {language.t(
                  physical?.state.pending.recover
                    ? "physicalsystems.connection.recovering"
                    : "physicalsystems.connection.recover",
                )}
              </button>
            </Show>
            <Show when={physical?.state.failures.recover}>
              <p role="alert">{physical?.state.failures.recover}</p>
            </Show>
          </div>
        </Show>
        <Show when={physical?.state.snapshot?.closeBlocked}>
          <p class="ps-operation" role="status">
            {language.t("physicalsystems.operations.closeBlocked")}
          </p>
        </Show>
        <For each={operations()}>
          {(operation) => (
            <div class="ps-operation">
              <div>
                <strong>{operation.owner.projectName ?? operation.owner.projectId}</strong>
                <span>{operation.label}</span>
                <Show when={operation.phase}>
                  <Phase value={operation.phase} />
                </Show>
                <Show when={operation.owner.statusUnavailable || physical?.state.unavailable}>
                  <p>
                    {language.t("physicalsystems.operations.lastObserved", {
                      phase: operation.phase || language.t("physicalsystems.unverified"),
                    })}
                  </p>
                </Show>
                <Show when={operation.owner.error}>
                  <p role="status">{operation.owner.error}</p>
                </Show>
                <Show when={physical?.state.failures[`stop:${operation.key}`]}>
                  <p role="alert">{language.t("physicalsystems.operations.unconfirmed")}</p>
                </Show>
              </div>
              <button
                type="button"
                class="ps-stop"
                data-ps-stop={operation.key}
                disabled={
                  !operation.owner.canStop ||
                  !operation.owner.conversationId ||
                  physical?.state.pending[`stop:${operation.key}`] ||
                  physical?.state.snapshot?.hostUnavailable
                }
                onClick={() => void physical?.send(operation.command, `stop:${operation.key}`)}
              >
                {language.t(
                  physical?.state.pending[`stop:${operation.key}`]
                    ? "physicalsystems.operations.stopping"
                    : "physicalsystems.operations.stop",
                )}
              </button>
            </div>
          )}
        </For>
      </aside>
    </Show>
  )
}
