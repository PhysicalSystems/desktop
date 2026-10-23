// SPDX-License-Identifier: Apache-2.0
import { createEffect, createMemo, onCleanup, Show, untrack } from "solid-js"
import { useLanguage } from "../runtime/i18n/language"
import { usePhysicalSystems } from "./context"
import { useModelAccount } from "./model-account"

export function ModelRuntime() {
  const language = useLanguage()
  const physical = usePhysicalSystems()
  const account = useModelAccount()
  const current = () => physical?.state.snapshot?.modelRuntime
  const connected = createMemo(() => physical?.project()?.connection.status === "connected" && Boolean(physical?.scope()))
  const connection = createMemo(() => {
    const scope = physical?.scope()
    return connected() && scope ? `${scope.projectId}:${scope.conversationId}:${scope.connectionGeneration}` : null
  })
  const refresh = () => {
    const scope = physical?.scope()
    if (scope && connected()) void physical?.send({ type: "inference.refresh", ...scope }, "model-runtime")
  }
  createEffect(() => {
    if (!connection()) return
    untrack(refresh)
    const timer = setInterval(() => { if (current()?.runtimeId) refresh() }, 2000)
    onCleanup(() => clearInterval(timer))
  })
  const matches = () => {
    const selection = account?.state.snapshot?.selection
    if (selection?.kind !== "company") return false
    return selection.manifestSha256 === current()?.manifestSha256 && selection.releaseId === current()?.releaseId
  }
  const load = () => {
    const scope = physical?.scope()
    const value = current()
    if (!scope || !matches() || !value?.manifestSha256 || !value.generation) return
    void physical?.send({ type: "inference.start", ...scope, manifestSha256: value.manifestSha256, generation: value.generation }, "model-runtime")
  }
  const stop = () => {
    const scope = physical?.scope()
    const runtimeId = current()?.runtimeId
    if (scope && runtimeId) void physical?.send({ type: "inference.stop", ...scope, runtimeId }, "model-runtime-stop")
  }
  return (
    <section class="ps-model-option" aria-label={language.t("physicalsystems.inference.title")}>
      <h3>{language.t("physicalsystems.inference.title")}</h3>
      <p class="ps-model-muted">{language.t("physicalsystems.inference.description")}</p>
      <Show when={connected()} fallback={<p>{language.t("physicalsystems.inference.connect")}</p>}>
        <Show when={current()} fallback={<p>{language.t("physicalsystems.inference.unavailable")}</p>}>
          <p role="status">{language.t(`physicalsystems.inference.${current()!.phase}`)}</p>
          <Show when={current()?.details}>
            <p class="ps-model-muted">{language.t("physicalsystems.inference.readyDetail", { gpu: current()!.details!.gpu, ms: String(current()!.details!.warmupMs) })}</p>
          </Show>
          <Show when={current()?.error}><p role="alert">{language.t("physicalsystems.inference.failed")} <code>{current()!.error}</code></p></Show>
          <Show when={!matches()}><p>{language.t("physicalsystems.inference.selection")}</p></Show>
        </Show>
        <div class="ps-model-actions">
          <button onClick={load} disabled={!matches() || Boolean(current()?.runtimeId) || Boolean(physical?.state.pending["model-runtime"])}>{language.t("physicalsystems.inference.load")}</button>
          <button onClick={stop} disabled={!current()?.runtimeId || Boolean(physical?.state.pending["model-runtime-stop"])}>{language.t("physicalsystems.inference.stop")}</button>
          <button onClick={refresh} disabled={Boolean(physical?.state.pending["model-runtime"])}>{language.t("physicalsystems.account.refresh")}</button>
        </div>
        <Show when={physical?.state.failures["model-runtime"] || physical?.state.failures["model-runtime-stop"]}>
          <p role="alert">{physical?.state.failures["model-runtime-stop"] || physical?.state.failures["model-runtime"]}</p>
        </Show>
      </Show>
    </section>
  )
}
