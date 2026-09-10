// SPDX-License-Identifier: Apache-2.0
import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "../context/language"
import { usePhysicalSystems } from "./context"
import { CameraPreview } from "./camera"
import { ExperimentsPanel, Phase } from "./experiments"
import { executionFresh } from "./state"
import { GripperCommissioning } from "./commissioning"

function DevicesPanel() {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const devices = () => physical.state.snapshot?.workcell?.workflow?.snapshot?.discovery?.devices ?? []
  return (
    <div class="ps-stack">
      <button
        type="button"
        disabled={!physical.bound() || physical.state.unavailable || physical.state.pending.action}
        onClick={() => {
          const scope = physical.scope()
          if (scope) void physical.send({ type: "workcell.refresh", ...scope })
        }}
      >
        {language.t("physicalsystems.refresh")}
      </button>
      <Show when={devices().length} fallback={<p class="ps-muted">{language.t("physicalsystems.devices.empty")}</p>}>
        <For each={devices()}>
          {(device) => (
            <details class="ps-card">
              <summary>
                <strong>{device.displayName ?? device.deviceId}</strong>
                <span class="ps-muted">
                  {language.t(
                    device.detected === true
                      ? "physicalsystems.devices.detected"
                      : device.detected === false
                        ? "physicalsystems.devices.absent"
                        : "physicalsystems.unverified",
                  )}
                </span>
              </summary>
              <p>
                {device.kind} · {device.readiness ?? language.t("physicalsystems.unverified")}
              </p>
              <p>{language.t("physicalsystems.devices.identity", { id: device.deviceId })}</p>
              <Show when={device.adapterId}>
                <p>{language.t("physicalsystems.devices.adapter", { id: device.adapterId! })}</p>
                <p>{device.adapterStatus}</p>
              </Show>
            </details>
          )}
        </For>
      </Show>
      <CameraPreview />
    </div>
  )
}

function SetupPanel() {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const report = () => physical.state.snapshot?.setupReport ?? physical.state.snapshot?.workcell?.setup
  const findings = () => [
    ...(report()?.checks ?? []),
    ...(report()?.requestBlockers ?? []),
    ...(report()?.implementations ?? []).flatMap((implementation) => implementation.checks ?? []),
  ]
  return (
    <div class="ps-stack">
      <GripperCommissioning />
      <p class="ps-muted">{language.t("physicalsystems.setup.empty")}</p>
      <button
        type="button"
        disabled={!physical.bound() || physical.state.unavailable || physical.state.pending.action}
        onClick={() => {
          const scope = physical.scope()
          if (scope) void physical.send({ type: "workcell.setup.inspect", ...scope })
        }}
      >
        {language.t("physicalsystems.setup.inspect")}
      </button>
      <Show when={report()?.inspection?.message}>
        <p>{report()?.inspection?.message}</p>
      </Show>
      <For each={findings()}>
        {(finding) => (
          <section class="ps-card">
            <div class="ps-heading">
              <strong>{finding.id ?? finding.code}</strong>
              <Phase value={finding.status} />
            </div>
            <p>{finding.message ?? finding.detail}</p>
            <Show when={finding.action}>
              <p>{finding.action}</p>
            </Show>
          </section>
        )}
      </For>
    </div>
  )
}

function RunPanel() {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const [state, setState] = createStore({ configuration: "", confirmed: "", now: Date.now() })
  const timer = setInterval(() => setState("now", Date.now()), 250)
  onCleanup(() => clearInterval(timer))
  const execution = () => physical.state.snapshot?.workcell?.execution
  const run = () => execution()?.run
  const consent = () =>
    JSON.stringify([physical.state.snapshot?.serviceId, physical.scope(), run()?.runId, run()?.runDigest])
  const fresh = () => executionFresh(execution(), state.now)
  const canApprove = () =>
    fresh() &&
    execution()?.canApprove === true &&
    !execution()?.stopPending &&
    !physical.state.pending[`stop:run:${physical.state.snapshot?.activeProjectId}:${run()?.runId}`] &&
    run()?.phase === "WAITING_FOR_APPROVAL" &&
    run()?.approval?.approvedAt === null &&
    new Date(run()?.approval?.expiresAt ?? 0).getTime() > state.now &&
    !physical.state.unavailable &&
    physical.bound()
  createEffect(() => {
    if (!canApprove() || state.confirmed !== consent()) setState("confirmed", "")
  })
  const prepare = () => {
    const scope = physical.scope()
    const configuration = execution()?.configurations?.find((item) => item.configurationId === state.configuration)
    const route = physical.state.snapshot?.workcell?.workflow?.routeReceipt
    if (scope && configuration && route && fresh())
      void physical.send({
        type: "workcell.execution.prepare",
        ...scope,
        configurationId: configuration.configurationId,
        expectedConfigurationDigest: configuration.configurationDigest,
        routeReceiptDigest: route.receiptDigest,
      })
  }
  const approve = () => {
    const scope = physical.scope()
    const record = run()
    if (scope && record?.runDigest && record.approval && canApprove() && state.confirmed === consent())
      void physical.send({
        type: "workcell.execution.approve",
        ...scope,
        runId: record.runId,
        expectedRunDigest: record.runDigest,
        approvalDigest: record.approval.digest,
        approved: true,
      })
  }
  return (
    <div class="ps-stack">
      <button
        type="button"
        disabled={!physical.bound() || physical.state.unavailable || physical.state.pending.action}
        onClick={() => {
          const scope = physical.scope()
          if (scope) void physical.send({ type: "workcell.execution.refresh", ...scope })
        }}
      >
        {language.t("physicalsystems.refresh")}
      </button>
      <label>
        {language.t("physicalsystems.run.configuration")}
        <select value={state.configuration} onChange={(event) => setState("configuration", event.currentTarget.value)}>
          <option value="">{language.t("physicalsystems.run.configuration")}</option>
          <For each={execution()?.configurations}>
            {(configuration) => (
              <option value={configuration.configurationId}>
                {configuration.displayName ?? configuration.configurationId}
              </option>
            )}
          </For>
        </select>
      </label>
      <button
        type="button"
        disabled={
          !physical.bound() ||
          physical.state.unavailable ||
          physical.state.pending.action ||
          !fresh() ||
          !execution()?.canPrepare ||
          !state.configuration
        }
        onClick={prepare}
      >
        {language.t("physicalsystems.run.prepare")}
      </button>
      <Show when={run()} fallback={<p class="ps-muted">{language.t("physicalsystems.run.empty")}</p>}>
        {(record) => (
          <section class="ps-card ps-stack">
            <Phase value={record().stopStatus ?? record().phase} />
            <p>
              {language.t(
                record().mode === "simulation" ? "physicalsystems.run.simulation" : "physicalsystems.run.physical",
              )}
            </p>
            <code>{record().configurationId}</code>
            <pre class="ps-evidence">{JSON.stringify(record().inputs ?? {}, null, 2)}</pre>
            <Show when={record().phase === "WAITING_FOR_APPROVAL"}>
              <label class="ps-check">
                <input
                  type="checkbox"
                  checked={state.confirmed === consent()}
                  disabled={!canApprove() || physical.state.pending.action}
                  onChange={(event) => setState("confirmed", event.currentTarget.checked ? consent() : "")}
                />
                {language.t("physicalsystems.run.confirm")}
              </label>
              <button
                type="button"
                class="ps-primary"
                disabled={!canApprove() || state.confirmed !== consent() || physical.state.pending.action}
                onClick={approve}
              >
                {language.t("physicalsystems.run.approve")}
              </button>
            </Show>
            <button
              type="button"
              disabled={!physical.bound() || physical.state.unavailable || physical.state.pending.action}
              onClick={() => {
                const scope = physical.scope()
                if (scope)
                  void physical.send({
                    type: "workcell.execution.reconcile",
                    ...scope,
                    runId: record().runId,
                    expectedRunDigest: record().runDigest,
                  })
              }}
            >
              {language.t("physicalsystems.run.reconcile")}
            </button>
            <details>
              <summary>{language.t("physicalsystems.run.evidence")}</summary>
              <pre class="ps-evidence">{JSON.stringify(record(), null, 2)}</pre>
            </details>
          </section>
        )}
      </Show>
      <For each={execution()?.runs?.filter((record) => record.runId !== run()?.runId)}>
        {(record) => (
          <button
            type="button"
            disabled={!physical.bound() || physical.state.pending.action}
            onClick={() => {
              const scope = physical.scope()
              if (scope) void physical.send({ type: "workcell.execution.select", ...scope, runId: record.runId })
            }}
          >
            {record.runId}
            <Phase value={record.phase} />
          </button>
        )}
      </For>
    </div>
  )
}

export function PhysicalPanel() {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const tabs = ["devices", "setup", "run", "experiments"] as const
  return (
    <aside class="ps-panel" data-ps-panel aria-label={language.t("physicalsystems.name")}>
      <div class="ps-heading ps-panel-heading">
        <strong>{language.t("physicalsystems.name")}</strong>
        <button
          type="button"
          aria-label={language.t("physicalsystems.panel.close")}
          onClick={() => physical.setState("panelOpen", false)}
        >
          ×
        </button>
      </div>
      <div class="ps-tabs" role="tablist" aria-label={language.t("physicalsystems.name")}>
        <For each={tabs}>
          {(tab) => (
            <button
              id={`ps-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={physical.state.panel === tab}
              aria-controls={`ps-panel-${tab}`}
              tabindex={physical.state.panel === tab ? 0 : -1}
              data-ps-tab={tab}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
                event.preventDefault()
                const index =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length
                physical.setState("panel", tabs[index])
                document.getElementById(`ps-tab-${tabs[index]}`)?.focus()
              }}
              onClick={() => physical.setState("panel", tab)}
            >
              {language.t(`physicalsystems.panel.${tab}`)}
            </button>
          )}
        </For>
      </div>
      <div
        class="ps-panel-content"
        role="tabpanel"
        id={`ps-panel-${physical.state.panel}`}
        aria-labelledby={`ps-tab-${physical.state.panel}`}
      >
        <Show when={physical.state.unavailable}>
          <p role="status" class="ps-error">
            {language.t("physicalsystems.connection.unavailable")}
          </p>
        </Show>
        <Show
          when={physical.bound()}
          fallback={
            <p class="ps-muted">
              {language.t(
                physical.state.binding
                  ? "physicalsystems.conversation.binding"
                  : "physicalsystems.conversation.unbound",
              )}
            </p>
          }
        >
          <Show when={physical.state.panel === "devices"}>
            <DevicesPanel />
          </Show>
          <Show when={physical.state.panel === "setup"}>
            <SetupPanel />
          </Show>
          <Show when={physical.state.panel === "run"}>
            <RunPanel />
          </Show>
          <Show when={physical.state.panel === "experiments"}>
            <ExperimentsPanel />
          </Show>
        </Show>
        <Show when={physical.state.failures.action}>
          <p role="alert" class="ps-error">
            {physical.state.failures.action}
          </p>
        </Show>
      </div>
    </aside>
  )
}
