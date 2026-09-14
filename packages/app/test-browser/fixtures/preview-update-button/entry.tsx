import { createMemo, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider, useLanguage } from "../../../src/context/language"
import { UpdaterButton, updaterButtonState } from "../../../src/components/updater-button"
import { useUpdaterAction } from "../../../src/components/updater-action"
import type { UpdaterState } from "../../../src/updater"
import { fixture } from "./environment"

export function mount(
  root: HTMLElement,
  initial: UpdaterState,
  backend: {
    check(): Promise<UpdaterState>
    download(): Promise<UpdaterState>
    install(): Promise<void>
    recover(): Promise<UpdaterState>
    open(url: string): Promise<boolean>
  },
  os: "windows" | "linux",
) {
  fixture.toasts = []
  const [store, setStore] = createStore({ state: structuredClone(initial) })
  const publish = (state: UpdaterState) => {
    setStore("state", reconcile(structuredClone(state)))
    return state
  }
  function Control() {
    const action = useUpdaterAction()
    const language = useLanguage()
    const state = createMemo(() =>
      updaterButtonState(store.state, language, () => {
        void action.run()
      }),
    )
    return (
      <Show when={state().visible}>
        <UpdaterButton state={state()} />
      </Show>
    )
  }
  const dispose = render(
    () => (
      <PlatformProvider
        value={{
          platform: "desktop",
          os,
          version: "0.1.0-beta.7",
          openExternal: backend.open,
          async openDirectoryPickerDialog() {
            return null
          },
          async restart() {
            throw new Error("The renderer must hand installation to its native updater")
          },
          async notify() {},
          updater: {
            state: () => store.state,
            check: async () => publish(await backend.check()),
            download: async () => publish(await backend.download()),
            install: backend.install,
            recover: async () => publish(await backend.recover()),
          },
        }}
      >
        <LanguageProvider locale="en">
          <Control />
        </LanguageProvider>
      </PlatformProvider>
    ),
    root,
  )
  return { dispose, publish, fixture }
}
