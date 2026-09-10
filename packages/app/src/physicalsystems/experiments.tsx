// SPDX-License-Identifier: Apache-2.0
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ToolRegistry, type ToolProps } from "@opencode-ai/session-ui/message-part"
import { useLanguage } from "../context/language"
import { usePhysicalSystems } from "./context"
import { continuationRequest, experimentExpired, physicalTimestamp, trustedExperiment } from "./state"
import type { PhysicalExperiment } from "./types"
import type { physicalSystemsEnglish } from "./i18n"

export function Phase(props: { value?: string }) {
  const language = useLanguage()
  const known = [
    "WAITING_FOR_APPROVAL",
    "STOPPING",
    "met",
    "violated",
    "unknown",
    "PROPOSED",
    "READY",
    "RUNNING",
    "COMPLETED",
    "STOPPED",
    "FAILED",
    "EXPIRED",
    "OUTCOME_UNKNOWN",
    "STOP_UNCONFIRMED",
  ]
  return (
    <span class="ps-badge">
      {known.includes(props.value ?? "")
        ? language.t(`physicalsystems.phase.${props.value}` as keyof typeof physicalSystemsEnglish)
        : (props.value ?? language.t("physicalsystems.unverified"))}
    </span>
  )
}

export function ExperimentCard(props: { record: PhysicalExperiment; historical?: boolean; inline?: boolean }) {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const [state, setState] = createStore({ confirmed: "", now: Date.now() })
  const timer = setInterval(() => setState("now", Date.now()), 500)
  onCleanup(() => clearInterval(timer))
  const requestIds = new Map<string, string>()
  const active = createMemo(
    () =>
      !props.historical &&
      physical.bound() &&
      physical.state.snapshot?.experiments?.current?.id === props.record.id &&
      physical.state.snapshot.experiments.current.planDigest === props.record.planDigest,
  )
  const consent = () =>
    JSON.stringify([physical.state.snapshot?.serviceId, physical.scope(), props.record.id, props.record.planDigest])
  const expired = () => experimentExpired(props.record, state.now)
  const pending = () => physical.state.pending[`experiment:${props.record.id}`]
  const retry = () => continuationRequest(physical.state.snapshot, props.record)
  const stopping = () =>
    physical.state.pending[`stop:experiment:${physical.state.snapshot?.activeProjectId}:${props.record.id}`]
  const disabled = () =>
    physical.state.unavailable ||
    !active() ||
    pending() ||
    stopping() ||
    physical.state.snapshot?.conversation?.busy ||
    expired()
  createEffect(() => {
    if (!active() || expired() || props.record.phase !== "PROPOSED") setState("confirmed", "")
  })
  const continuation = (approve: boolean) => {
    const scope = physical.scope()
    if (!scope || disabled() || (approve && state.confirmed !== consent())) return
    const key = [
      scope.projectId,
      scope.conversationId,
      scope.connectionGeneration,
      props.record.id,
      props.record.planDigest,
      props.record.trials.length,
      approve,
    ].join(":")
    const requestId = retry() ?? requestIds.get(key) ?? crypto.randomUUID()
    requestIds.set(key, requestId)
    const exact = { ...scope, experimentId: props.record.id, expectedDigest: props.record.planDigest, requestId }
    void physical.send(
      approve
        ? { type: "experiment.approveAndContinue", ...exact, approved: true }
        : { type: "experiment.continue", ...exact },
      `experiment:${props.record.id}`,
    )
  }
  const finish = () => {
    const scope = physical.scope()
    if (scope && active())
      void physical.send(
        { type: "experiment.finish", ...scope, experimentId: props.record.id },
        `experiment:${props.record.id}`,
      )
  }
  const best = () =>
    props.record.trials
      .filter((trial) => trial.status === "COMPLETED" && Number.isFinite(trial.result?.alignmentErrorMm))
      .reduce<
        number | undefined
      >((value, trial) => (value === undefined || trial.result!.alignmentErrorMm! < value ? trial.result!.alignmentErrorMm : value), undefined)
  return (
    <section class="ps-card ps-experiment" data-ps-experiment-card={props.record.id}>
      <div class="ps-heading">
        <span class="ps-badge">{language.t("physicalsystems.experiment.simulation")}</span>
        <Phase value={props.record.phase} />
      </div>
      <h3>{props.record.goal}</h3>
      <p>
        {language.t("physicalsystems.experiment.trials", {
          used: props.record.trials.length,
          limit: props.record.trialLimit,
        })}
      </p>
      <Show when={props.historical}>
        <p class="ps-muted">{language.t("physicalsystems.experiment.historical")}</p>
      </Show>
      <Show
        when={props.record.trials.length}
        fallback={<p class="ps-muted">{language.t("physicalsystems.experiment.noTrials")}</p>}
      >
        <table>
          <caption class="ps-sr-only">{language.t("physicalsystems.experiment.evidence")}</caption>
          <thead>
            <tr>
              <th>{language.t("physicalsystems.experiment.trial")}</th>
              <th>{language.t("physicalsystems.experiment.offset")}</th>
              <th>{language.t("physicalsystems.experiment.error")}</th>
              <th>{language.t("physicalsystems.experiment.status")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.record.trials}>
              {(trial, index) => (
                <tr>
                  <td>{index() + 1}</td>
                  <td>{trial.offsetMm ?? trial.parameters?.offsetMm ?? language.t("physicalsystems.unverified")}</td>
                  <td>{trial.result?.alignmentErrorMm ?? language.t("physicalsystems.unverified")}</td>
                  <td>
                    <Phase value={trial.status ?? trial.phase} />
                    <Show when={trial.error}>
                      <p>{trial.error}</p>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <Show when={best() !== undefined}>
        <p>{language.t("physicalsystems.experiment.best", { value: best()! })}</p>
      </Show>
      <Show when={props.record.summary?.interpretation}>
        <p>{props.record.summary?.interpretation}</p>
      </Show>
      <Show when={props.record.reason ?? props.record.error?.message ?? props.record.recoveryReason}>
        {(reason) => <p role="status">{reason()}</p>}
      </Show>
      <Show when={active()}>
        <Show when={props.record.phase === "PROPOSED"}>
          <p class="ps-muted">
            {language.t("physicalsystems.experiment.expires", {
              time:
                physicalTimestamp(props.record.expiresAt, language.intl()) ?? language.t("physicalsystems.unverified"),
            })}
          </p>
          <label class="ps-check">
            <input
              type="checkbox"
              checked={state.confirmed === consent()}
              disabled={disabled()}
              onChange={(event) => setState("confirmed", event.currentTarget.checked ? consent() : "")}
            />
            {language.t("physicalsystems.experiment.confirm")}
          </label>
          <button
            type="button"
            class="ps-primary"
            data-ps-approve
            disabled={disabled() || state.confirmed !== consent()}
            onClick={() => continuation(true)}
          >
            {language.t(pending() ? "physicalsystems.pending" : "physicalsystems.experiment.approve")}
          </button>
        </Show>
        <Show when={props.record.phase === "READY"}>
          <Show when={props.record.trials.length < props.record.trialLimit}>
            <button
              type="button"
              class="ps-primary"
              data-ps-continue
              disabled={disabled()}
              onClick={() => continuation(false)}
            >
              {language.t(
                pending()
                  ? "physicalsystems.pending"
                  : retry()
                    ? "physicalsystems.experiment.checkContinuation"
                    : "physicalsystems.experiment.continue",
              )}
            </button>
          </Show>
          <button
            type="button"
            disabled={
              physical.state.unavailable ||
              pending() ||
              !props.record.trials.some((trial) => trial.status === "COMPLETED")
            }
            onClick={finish}
          >
            {language.t("physicalsystems.experiment.finish")}
          </button>
        </Show>
        <Show when={expired() && ["PROPOSED", "READY"].includes(props.record.phase)}>
          <p role="status">{language.t("physicalsystems.experiment.expired")}</p>
        </Show>
      </Show>
      <Show when={physical.state.failures[`experiment:${props.record.id}`]}>
        {(error) => (
          <p role="alert" class="ps-error">
            {error()}
          </p>
        )}
      </Show>
      <Show when={props.inline}>
        <button type="button" onClick={() => physical.setState({ panel: "experiments", panelOpen: true })}>
          {language.t("physicalsystems.experiment.details")}
        </button>
      </Show>
      <details>
        <summary>{language.t("physicalsystems.experiment.evidence")}</summary>
        <code class="ps-evidence">
          {props.record.id}
          <br />
          {props.record.planDigest}
        </code>
      </details>
    </section>
  )
}

export function ExperimentsPanel() {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const [form, setForm] = createStore({ goal: "", budget: 4 })
  const current = () => physical.state.snapshot?.experiments?.current
  const active = () => ["PROPOSED", "READY", "RUNNING", "OUTCOME_UNKNOWN"].includes(current()?.phase ?? "")
  const propose = (event: SubmitEvent) => {
    event.preventDefault()
    const scope = physical.scope()
    if (!scope || !form.goal.trim() || physical.state.unavailable) return
    void physical.send({
      type: "experiment.propose",
      ...scope,
      goal: form.goal.trim(),
      trialLimit: form.budget,
      requestId: crypto.randomUUID(),
    })
  }
  return (
    <div class="ps-stack">
      <p class="ps-muted">{language.t("physicalsystems.experiment.intro")}</p>
      <Show when={current()} fallback={<p>{language.t("physicalsystems.experiment.empty")}</p>}>
        {(record) => <ExperimentCard record={record()} historical={physical.state.snapshot?.experiments?.historical} />}
      </Show>
      <Show when={!active()}>
        <form onSubmit={propose} class="ps-stack">
          <label>
            {language.t("physicalsystems.experiment.goal")}
            <textarea
              required
              maxlength={1000}
              value={form.goal}
              onInput={(event) => setForm("goal", event.currentTarget.value)}
            />
          </label>
          <label>
            {language.t("physicalsystems.experiment.budget")}
            <input
              type="number"
              required
              min="1"
              max="10"
              value={form.budget}
              onInput={(event) => setForm("budget", Number(event.currentTarget.value))}
            />
          </label>
          <button
            type="submit"
            disabled={
              !physical.bound() ||
              physical.state.unavailable ||
              physical.state.pending.action ||
              physical.state.snapshot?.experiments?.availability !== "simulation-only"
            }
          >
            {language.t("physicalsystems.experiment.propose")}
          </button>
        </form>
      </Show>
      <Show when={physical.state.snapshot?.experiments?.history?.length}>
        <details>
          <summary>{language.t("physicalsystems.experiment.history")}</summary>
          <For each={physical.state.snapshot?.experiments?.history?.filter((record) => record.id !== current()?.id)}>
            {(record) => <ExperimentCard record={record} historical />}
          </For>
        </details>
      </Show>
    </div>
  )
}

function PhysicalToolCard(props: ToolProps) {
  const physical = usePhysicalSystems()
  const language = useLanguage()
  const record = createMemo(() =>
    trustedExperiment(
      physical?.state.snapshot,
      props.metadata?.physicalSystems,
      props.sessionID,
      physical?.state.view?.serverId,
    ),
  )
  return (
    <Show
      when={physical && record()}
      fallback={
        <div class="ps-card">
          <p>{language.t("physicalsystems.experiment.untrusted")}</p>
        </div>
      }
    >
      {(value) => (
        <ExperimentCard
          record={value()}
          inline
          historical={physical?.state.snapshot?.experiments?.current?.id !== value().id}
        />
      )}
    </Show>
  )
}

// Registration is the existing extension boundary. The session timeline itself is unchanged.
for (const name of [
  "inspect_local_experiment",
  "propose_local_experiment",
  "run_simulated_trial",
  "finish_local_experiment",
]) {
  ToolRegistry.register({ name, render: PhysicalToolCard })
}
