// SPDX-License-Identifier: Apache-2.0
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "../context/language"
import { usePhysicalSystems } from "./context"
import { Phase } from "./experiments"
import {
  commissioningCanApprove,
  commissioningConsent,
  commissioningFresh,
  commissioningTarget,
} from "./commissioning-state"

export function GripperCommissioning() {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const [state, setState] = createStore({ now: Date.now(), target: "", confirmed: "", context: "" })
  const timer = setInterval(() => setState("now", Date.now()), 250)
  onCleanup(() => clearInterval(timer))
  // A new IPC snapshot can arrive between timer ticks. Check its receipt
  // against the current clock, otherwise each poll briefly clears consent.
  const now = () => Math.max(Date.now(), state.now)
  const view = () => physical.state.snapshot?.workcell?.commissioning
  const status = () => view()?.status
  const trial = () => status()?.trial
  const fresh = () => commissioningFresh(view(), now())
  const connected = () => {
    const connection = physical.project()?.connection
    return (connection?.kind === "local" || connection?.kind === "ssh") && connection.status === "connected"
  }
  const canRefresh = () =>
    connected() && physical.bound() && !physical.state.unavailable && !physical.state.pending.action
  const available = () => connected() && physical.bound() && !physical.state.unavailable && fresh()
  const target = () => commissioningTarget(view(), state.target, now())
  const consent = () => commissioningConsent(physical.state.snapshot)
  const stopKey = () => `stop:commissioning:${physical.state.snapshot?.activeProjectId}:${trial()?.trialId}`
  const canApprove = () => available() && commissioningCanApprove(view(), now()) && !physical.state.pending[stopKey()]
  const context = createMemo(() =>
    JSON.stringify([
      physical.scope(),
      status()?.nodeSessionId,
      status()?.configuration?.digest,
      status()?.inspection?.digest,
    ]),
  )
  const refreshed = new Set<string>()
  createEffect(() => {
    const scope = physical.scope()
    const key = JSON.stringify([physical.state.snapshot?.serviceId, scope])
    if (!scope || status() || !canRefresh() || refreshed.has(key)) return
    refreshed.add(key)
    // Status is metadata only. Inspection and all effects require explicit actions.
    void physical.send({ type: "workcell.commissioning.refresh", ...scope })
  })
  createEffect(() => {
    if (state.context !== context()) setState({ context: context(), target: "", confirmed: "" })
    if (!canApprove() || state.confirmed !== consent()) setState("confirmed", "")
  })
  const refresh = () => {
    const scope = physical.scope()
    if (scope && canRefresh()) void physical.send({ type: "workcell.commissioning.refresh", ...scope })
  }
  const inspect = () => {
    const scope = physical.scope()
    if (scope && available() && status()?.canInspect)
      void physical.send({ type: "workcell.commissioning.inspect", ...scope })
  }
  const prepare = () => {
    const scope = physical.scope()
    const configuration = status()?.configuration
    const inspection = status()?.inspection
    const position = target()
    if (scope && available() && configuration && inspection && position !== undefined)
      void physical.send({
        type: "workcell.commissioning.prepare",
        ...scope,
        configurationDigest: configuration.digest,
        inspectionDigest: inspection.digest,
        targetPosition: position,
      })
  }
  const approve = () => {
    const scope = physical.scope()
    const record = trial()
    if (scope && record && canApprove() && state.confirmed === consent())
      void physical.send({
        type: "workcell.commissioning.approve",
        ...scope,
        trialId: record.trialId,
        trialDigest: record.digest,
        approved: true,
      })
  }
  const stop = () => {
    const scope = physical.scope()
    const record = trial()
    if (scope && record && status()?.canStop)
      void physical.send(
        { type: "workcell.commissioning.stop", ...scope, trialId: record.trialId, reason: "operator-requested-stop" },
        stopKey(),
      )
  }
  return (
    <section class="ps-card ps-stack" data-ps-commissioning>
      <h3>{language.t("physicalsystems.commissioning.title")}</h3>
      <p>{language.t("physicalsystems.commissioning.description")}</p>
      <button type="button" data-ps-commissioning-refresh disabled={!canRefresh()} onClick={refresh}>
        {language.t("physicalsystems.refresh")}
      </button>
      <Show when={view()?.message}>
        <p role="status">{view()?.message}</p>
      </Show>
      <Show when={status()?.blockedReason}>
        <p role="status">{status()?.blockedReason}</p>
      </Show>
      <Show when={!view()?.available && !view()?.message}>
        <p class="ps-muted">{language.t("physicalsystems.commissioning.unavailable")}</p>
      </Show>
      <Show when={status()?.configuration}>
        {(configuration) => (
          <>
            <strong>{configuration().displayName}</strong>
            <p>{language.t("physicalsystems.commissioning.device", { identity: configuration().deviceIdentity })}</p>
            <Show when={!fresh()}>
              <p role="status">{language.t("physicalsystems.commissioning.stale")}</p>
            </Show>
            <button
              type="button"
              data-ps-commissioning-inspect
              disabled={
                !available() || !status()?.canInspect || Boolean(view()?.pending) || physical.state.pending.action
              }
              onClick={inspect}
            >
              {language.t("physicalsystems.commissioning.inspect")}
            </button>
            <Show when={status()?.inspection}>
              {(inspection) => (
                <>
                  <p>
                    {language.t("physicalsystems.commissioning.gripperPosition", {
                      position: inspection().gripperPosition ?? "—",
                    })}
                  </p>
                  <For each={inspection().checks}>
                    {(check) => (
                      <div>
                        <Phase value={check.state} />
                        <p>{check.message}</p>
                      </div>
                    )}
                  </For>
                  <details>
                    <summary>{language.t("physicalsystems.commissioning.joints")}</summary>
                    <For each={Object.entries(inspection().positions)}>
                      {([joint, position]) => (
                        <p>
                          {language.t("physicalsystems.commissioning.jointState", {
                            joint,
                            position: position ?? language.t("physicalsystems.unverified"),
                            torque: language.t(
                              typeof inspection().torqueEnabled[joint] !== "boolean"
                                ? "physicalsystems.unverified"
                                : inspection().torqueEnabled[joint]
                                  ? "physicalsystems.commissioning.torqueOn"
                                  : "physicalsystems.commissioning.torqueOff",
                            ),
                          })}
                        </p>
                      )}
                    </For>
                  </details>
                </>
              )}
            </Show>
            <label>
              {language.t("physicalsystems.commissioning.target")}
              <input
                type="number"
                step="any"
                data-ps-commissioning-target
                min={configuration().minimum}
                max={configuration().maximum}
                value={state.target}
                disabled={!available() || !status()?.canPrepare || Boolean(view()?.pending)}
                onInput={(event) => setState({ target: event.currentTarget.value, confirmed: "" })}
              />
            </label>
            <p class="ps-muted">
              {language.t("physicalsystems.commissioning.limits", {
                minimum: configuration().minimum,
                maximum: configuration().maximum,
                delta: configuration().maximumDelta,
              })}
            </p>
            <button
              type="button"
              data-ps-commissioning-prepare
              disabled={!available() || target() === undefined || physical.state.pending.action}
              onClick={prepare}
            >
              {language.t("physicalsystems.commissioning.prepare")}
            </button>
          </>
        )}
      </Show>
      <Show when={trial()}>
        {(record) => (
          <section class="ps-stack" data-ps-commissioning-trial>
            <Phase value={record().phase} />
            <Show when={record().stopStatus}>
              <div>
                <span>{language.t("physicalsystems.commissioning.stopState")}</span>
                <Phase value={record().stopStatus!} />
              </div>
            </Show>
            <p>
              {language.t("physicalsystems.commissioning.plan", {
                start: record().startPosition,
                target: record().targetPosition,
                seconds: record().maximumDurationSeconds,
              })}
            </p>
            <p>{language.t("physicalsystems.commissioning.effect")}</p>
            <Show when={record().phase === "WAITING_FOR_APPROVAL"}>
              <label class="ps-check">
                <input
                  type="checkbox"
                  data-ps-commissioning-consent
                  disabled={!canApprove()}
                  checked={canApprove() && state.confirmed === consent()}
                  onChange={(event) => setState("confirmed", event.currentTarget.checked ? consent() : "")}
                />
                {language.t("physicalsystems.commissioning.consent")}
              </label>
              <button
                type="button"
                data-ps-commissioning-approve
                disabled={!canApprove() || state.confirmed !== consent() || physical.state.pending.action}
                onClick={approve}
              >
                {language.t("physicalsystems.commissioning.approve")}
              </button>
            </Show>
            <Show when={record().latestPosition !== null}>
              <p>
                {language.t("physicalsystems.commissioning.gripperPosition", { position: record().latestPosition! })}
              </p>
            </Show>
            <Show when={record().message}>
              <p role="status">{record().message}</p>
            </Show>
            <Show when={status()?.canStop || record().stopStatus === "STOP_UNCONFIRMED"}>
              <button
                type="button"
                class="ps-stop"
                data-ps-commissioning-stop
                disabled={!status()?.canStop || physical.state.unavailable || physical.state.pending[stopKey()]}
                onClick={stop}
              >
                {language.t("physicalsystems.operations.stop")}
              </button>
            </Show>
            <Show when={record().phase === "COMPLETED"}>
              <p>{language.t("physicalsystems.commissioning.completed")}</p>
            </Show>
          </section>
        )}
      </Show>
    </section>
  )
}
