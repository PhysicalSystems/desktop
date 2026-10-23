// SPDX-License-Identifier: Apache-2.0
import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "@opencode/ui/theme/context"
import { createStore } from "solid-js/store"
import { useLanguage } from "../runtime/i18n/language"
import { usePlatform } from "../runtime/platform/platform"
import { WorkcellRoom } from "./rooms/room"
import type { WorkcellAccountBridge, WorkcellAccountState } from "../../../physicalsystems/src/workcell-account-types"
import type { WorkcellRoomData, WorkcellTransport } from "./rooms/types"

export function NativeWorkcellRooms(props: {
  bridge: WorkcellAccountBridge
  onDraft(room: WorkcellRoomData): Promise<void>
  close(): void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const theme = useTheme()
  const [state, setState] = createStore({
    account: undefined as WorkcellAccountState | undefined,
    rooms: [] as WorkcellRoomData[],
    selected: "",
    busy: false,
    error: false,
  })
  const update = (account: WorkcellAccountState) => {
    if (state.account && account.revision < state.account.revision) return
    setState("account", account)
    if (account.status !== "signed_in") setState({ rooms: [], selected: "" })
  }
  onMount(() => {
    const unsubscribe = props.bridge.subscribe(update)
    void props.bridge.refresh().then(update, () => setState("error", true))
    onCleanup(unsubscribe)
  })
  const load = async () => {
    const revision = state.account?.revision
    await props.bridge
      .request("GET", "/api/workcells")
      .then((value) => {
        const rooms = (value as { workcells: WorkcellRoomData[] }).workcells
        if (state.account?.status !== "signed_in" || state.account.revision !== revision) return
        if (!Array.isArray(rooms)) throw new Error("INVALID_WORKCELL_LIST")
        setState({ rooms, error: false })
        if (!rooms.some((room) => room.id === state.selected)) setState("selected", rooms[0]?.id ?? "")
      })
      .catch(() => {
        if (state.account?.revision === revision) setState("error", true)
      })
  }
  createEffect(() => {
    if (state.account?.status === "signed_in") void load()
  })
  const call = async (operation: () => Promise<WorkcellAccountState>) => {
    if (state.busy) return
    setState({ busy: true, error: false })
    await operation()
      .then(update, () => setState("error", true))
      .finally(() => setState("busy", false))
  }
  const transport: WorkcellTransport = {
    request: async (method, path, body, signal) => {
      if (signal?.aborted) throw new Error("ABORTED")
      const result = await props.bridge.request(method, path, body)
      if (signal?.aborted) throw new Error("ABORTED")
      return result
    },
  }
  return (
    <section class="ps-cloud-rooms">
      <div class="ps-heading">
        <strong>{language.t("physicalsystems.rooms.title")}</strong>
        <button onClick={props.close}>{language.t("physicalsystems.rooms.back")}</button>
      </div>
      <Show when={state.error || state.account?.error}>
        <p role="alert" class="ps-error">
          {language.t("physicalsystems.rooms.error")}
        </p>
      </Show>
      <Show
        when={state.account?.status === "signed_in"}
        fallback={
          <div class="ps-stack">
            <p>{language.t("physicalsystems.rooms.signInDescription")}</p>
            <Show
              when={state.account?.pending}
              fallback={
                <button disabled={state.busy} onClick={() => void call(() => props.bridge.signIn())}>
                  {language.t("physicalsystems.rooms.signIn")}
                </button>
              }
            >
              {(pending) => (
                <>
                  <p>{language.t("physicalsystems.rooms.verify", { code: pending().userCode })}</p>
                  <button onClick={() => void platform.openExternal(pending().verificationUrl)}>
                    {language.t("physicalsystems.rooms.openBrowser")}
                  </button>
                  <button onClick={() => void call(() => props.bridge.cancelSignIn())}>
                    {language.t("physicalsystems.cancel")}
                  </button>
                </>
              )}
            </Show>
          </div>
        }
      >
        <div class="ps-cloud-room-toolbar">
          <label>
            {language.t("physicalsystems.rooms.choose")}{" "}
            <select value={state.selected} onChange={(event) => setState("selected", event.currentTarget.value)}>
              <For each={state.rooms}>{(room) => <option value={room.id}>{room.name}</option>}</For>
            </select>
          </label>
          <button disabled={state.busy} onClick={() => void load()}>
            {language.t("physicalsystems.refresh")}
          </button>
          <button disabled={state.busy} onClick={() => void call(() => props.bridge.signOut())}>
            {language.t("physicalsystems.account.signOut")}
          </button>
        </div>
        <Show when={state.selected} fallback={<p>{language.t("physicalsystems.rooms.empty")}</p>}>
          <WorkcellRoom
            workcellId={state.selected}
            transport={transport}
            theme={theme.mode()}
            navigate={(href) => void platform.openExternal(`https://physicalsystems.ai${href}`)}
            onPrepareTask={async (room) => {
              await props.onDraft(room)
              props.close()
            }}
          />
        </Show>
        <button onClick={() => void platform.openExternal("https://physicalsystems.ai/dashboard/workcells")}>
          {language.t("physicalsystems.rooms.openWeb")}
        </button>
      </Show>
    </section>
  )
}
