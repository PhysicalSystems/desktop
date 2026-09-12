// SPDX-License-Identifier: Apache-2.0
import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "../context/language"
import { usePhysicalSystems } from "./context"
import { Phase } from "./experiments"
import { physicalTimestamp } from "./state"
import {
  commissioningCanConfirmRecovery,
  commissioningRecoveryConsent,
  commissioningRecoveryFresh,
  commissioningRecoveryMatches,
  commissioningRecoveryOwner,
  commissioningRecoveryResolved,
  commissioningRecoveryView,
} from "./commissioning-state"

export function CommissioningRecovery() {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const [state, setState] = createStore({ now: Date.now(), review: false, confirmed: "", context: "" })
  const timer = setInterval(() => setState("now", Date.now()), 250)
  onCleanup(() => clearInterval(timer))
  const now = () => Math.max(Date.now(), state.now)
  const view = () => commissioningRecoveryView(physical.state.snapshot)
  const status = () => view()?.recoveryStatus ?? view()?.status
  const original = () => view()?.status ?? status()
  const trial = () => original()?.trial
  const recoveryTrial = () => {
    const value = status()?.trial
    return value?.trialId === trial()?.trialId && value?.digest === trial()?.digest ? value : undefined
  }
  const interrupted = () => {
    const owner = commissioningRecoveryOwner(physical.state.snapshot)
    return Boolean(
      owner?.recoveryView &&
        owner.statusUnavailable &&
        trial()?.phase === "RUNNING" &&
        recoveryTrial()?.phase !== "OUTCOME_UNKNOWN",
    )
  }
  const needsReview = () =>
    (trial()?.phase === "OUTCOME_UNKNOWN" || recoveryTrial()?.phase === "OUTCOME_UNKNOWN" || interrupted()) &&
    !resolved()
  const receipt = () => status()?.recoveryClearance
  const resolved = () => commissioningRecoveryResolved(view())
  const offer = () => {
    const value = status()?.recovery
    return commissioningRecoveryMatches(view(), value) ? value : undefined
  }
  const available = () => {
    const connection = physical.project()?.connection
    return (
      (connection?.kind === "local" || connection?.kind === "ssh") &&
      connection.status === "connected" &&
      physical.bound() &&
      !physical.state.unavailable &&
      !physical.state.pending.action &&
      !physical.state.pending[`stop:commissioning:${physical.state.snapshot?.activeProjectId}:${trial()?.trialId}`] &&
      !view()?.pending &&
      !view()?.stopPending
    )
  }
  const canInspect = () => available() && needsReview()
  const canConfirm = () => available() && commissioningCanConfirmRecovery(view(), now())
  const consent = () => commissioningRecoveryConsent(physical.state.snapshot)
  createEffect(() => {
    const context = JSON.stringify([
      physical.state.snapshot?.serviceId,
      physical.scope(),
      trial()?.trialId,
      trial()?.digest,
    ])
    if (context !== state.context) setState({ context, review: false, confirmed: "" })
    if (!canConfirm() || state.confirmed !== consent()) setState("confirmed", "")
  })
  const inspect = () => {
    const scope = physical.scope()
    const record = trial()
    if (scope && record && canInspect())
      void physical.send({
        type: "workcell.commissioning.recoveryInspect",
        ...scope,
        trialId: record.trialId,
        trialDigest: record.digest,
      })
  }
  const confirm = () => {
    const scope = physical.scope()
    const record = trial()
    const recovery = offer()
    if (scope && record && recovery && canConfirm() && state.confirmed === consent())
      void physical.send({
        type: "workcell.commissioning.recoveryConfirm",
        ...scope,
        trialId: record.trialId,
        trialDigest: record.digest,
        recoveryDigest: recovery.digest,
        confirmed: true,
      })
  }
  return (
    <>
      <Show when={needsReview()}>
        <section class="ps-stack" data-ps-commissioning-recovery>
          <button
            type="button"
            data-ps-recovery-review
            aria-expanded={state.review}
            onClick={() => setState("review", !state.review)}
          >
            {language.t(
              interrupted()
                ? "physicalsystems.commissioning.recovery.reviewInterrupted"
                : "physicalsystems.commissioning.recovery.review",
            )}
          </button>
          <Show when={state.review}>
            <p>
              {language.t(
                interrupted()
                  ? "physicalsystems.commissioning.recovery.interrupted"
                  : "physicalsystems.commissioning.recovery.description",
              )}
            </p>
            <p>{language.t("physicalsystems.commissioning.recovery.readOnly")}</p>
            <Show when={!physical.state.snapshot?.workcell?.commissioning && view()?.message}>
              <p role="status">{view()?.message}</p>
            </Show>
            <button type="button" data-ps-recovery-inspect disabled={!canInspect()} onClick={inspect}>
              {language.t(
                view()?.pending === "recoveryInspect"
                  ? "physicalsystems.commissioning.recovery.checking"
                  : "physicalsystems.commissioning.recovery.inspect",
              )}
            </button>
            <Show when={offer()}>
              {(recovery) => (
                <section class="ps-stack" data-ps-recovery-evidence>
                  <h4>{language.t("physicalsystems.commissioning.recovery.evidence")}</h4>
                  <For each={recovery().checks}>
                    {(check) => (
                      <div>
                        <Phase value={check.state} />
                        <p>{check.message}</p>
                      </div>
                    )}
                  </For>
                  <details>
                    <summary>{language.t("physicalsystems.commissioning.joints")}</summary>
                    <For each={Object.entries(recovery().positions)}>
                      {([joint, position]) => (
                        <p>
                          {language.t("physicalsystems.commissioning.jointState", {
                            joint,
                            position: position ?? language.t("physicalsystems.unverified"),
                            torque: language.t(
                              typeof recovery().torqueEnabled[joint] !== "boolean"
                                ? "physicalsystems.unverified"
                                : recovery().torqueEnabled[joint]
                                  ? "physicalsystems.commissioning.torqueOn"
                                  : "physicalsystems.commissioning.torqueOff",
                            ),
                          })}
                        </p>
                      )}
                    </For>
                  </details>
                  <Show when={Date.parse(recovery().expiresAt) <= now()}>
                    <p role="status">{language.t("physicalsystems.commissioning.recovery.expired")}</p>
                  </Show>
                  <Show when={Date.parse(recovery().expiresAt) > now() && !commissioningRecoveryFresh(view(), now())}>
                    <p role="status">{language.t("physicalsystems.commissioning.recovery.stale")}</p>
                  </Show>
                  <label class="ps-check">
                    <input
                      type="checkbox"
                      data-ps-recovery-consent
                      disabled={!canConfirm()}
                      checked={canConfirm() && state.confirmed === consent()}
                      onChange={(event) => setState("confirmed", event.currentTarget.checked ? consent() : "")}
                    />
                    {language.t("physicalsystems.commissioning.recovery.consent")}
                  </label>
                  <button
                    type="button"
                    data-ps-recovery-confirm
                    disabled={!canConfirm() || state.confirmed !== consent()}
                    onClick={confirm}
                  >
                    {language.t(
                      view()?.pending === "recoveryConfirm"
                        ? "physicalsystems.commissioning.recovery.confirming"
                        : "physicalsystems.commissioning.recovery.confirm",
                    )}
                  </button>
                </section>
              )}
            </Show>
          </Show>
        </section>
      </Show>
      <Show when={receipt()}>
        {(record) => (
          <section class="ps-stack" data-ps-recovery-receipt>
            <h4>
              {language.t(
                resolved()
                  ? "physicalsystems.commissioning.recovery.completed"
                  : "physicalsystems.commissioning.recovery.previous",
              )}
            </h4>
            <p>{language.t("physicalsystems.commissioning.recovery.next")}</p>
            <details>
              <summary>{language.t("physicalsystems.commissioning.recovery.record")}</summary>
              <p>{language.t("physicalsystems.commissioning.recovery.trial", { trial: record().trialId })}</p>
              <p>
                {language.t("physicalsystems.commissioning.recovery.confirmedAt", {
                  time:
                    physicalTimestamp(record().confirmedAt, language.intl()) ??
                    language.t("physicalsystems.unverified"),
                })}
              </p>
            </details>
          </section>
        )}
      </Show>
    </>
  )
}
