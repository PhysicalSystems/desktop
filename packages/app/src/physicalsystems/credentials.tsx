// SPDX-License-Identifier: Apache-2.0
import { onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useLanguage } from "../context/language"
import { usePhysicalSystems } from "./context"
import type { PhysicalProject } from "./types"

export function ProjectCredentials(props: { project: PhysicalProject; close: () => void }) {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const [state, setState] = createStore({ cameraToken: "", executionToken: "" })
  const dialog: { element?: HTMLDialogElement } = {}
  const clear = () => setState({ cameraToken: "", executionToken: "" })
  const close = () => {
    clear()
    props.close()
  }
  onMount(() => dialog.element?.show())
  onCleanup(clear)
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (
      physical.state.pending.credentials ||
      physical.state.unavailable ||
      props.project.connection.status !== "offline"
    )
      return
    const request = {
      type: "connection.saveCredential" as const,
      projectId: props.project.id,
      cameraToken: state.cameraToken,
      executionToken: state.executionToken || undefined,
    }
    clear()
    const result = await physical.send(request, "credentials")
    if (result) close()
  }
  return (
    <Portal>
      <dialog
        class="ps-dialog"
        data-ps-credentials
        ref={(element) => (dialog.element = element)}
        onCancel={close}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            close()
          }
        }}
        aria-modal="false"
        aria-labelledby="ps-credentials-title"
      >
        <form class="ps-stack" autocomplete="off" onSubmit={save}>
          <h2 id="ps-credentials-title">
            {language.t("physicalsystems.credentials.title", { name: props.project.name })}
          </h2>
          <label>
            {language.t("physicalsystems.credentials.camera")}
            <input
              data-ps-camera-token
              type="password"
              autocomplete="off"
              spellcheck={false}
              required
              autofocus
              value={state.cameraToken}
              onInput={(event) => setState("cameraToken", event.currentTarget.value)}
            />
          </label>
          <label>
            {language.t("physicalsystems.credentials.execution")}
            <input
              data-ps-execution-token
              type="password"
              autocomplete="off"
              spellcheck={false}
              value={state.executionToken}
              onInput={(event) => setState("executionToken", event.currentTarget.value)}
            />
          </label>
          <Show when={physical.state.failures.credentials}>
            <p role="alert" class="ps-error">
              {language.t("physicalsystems.credentials.failure")}
            </p>
          </Show>
          <div class="ps-actions">
            <button type="button" onClick={close}>
              {language.t("physicalsystems.cancel")}
            </button>
            <button
              type="submit"
              class="ps-primary"
              disabled={!state.cameraToken || physical.state.pending.credentials || physical.state.unavailable}
            >
              {language.t(physical.state.pending.credentials ? "physicalsystems.pending" : "physicalsystems.save")}
            </button>
          </div>
        </form>
      </dialog>
    </Portal>
  )
}
