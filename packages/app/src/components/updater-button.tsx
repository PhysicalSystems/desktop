import { Show } from "solid-js"
import type { useLanguage } from "@/context/language"
import type { UpdaterState } from "@/updater"
import { updaterAction } from "./updater-action"

export type UpdaterButtonState = {
  visible: boolean
  busy: boolean
  disabled: boolean
  label: string
  ariaLabel: string
  title?: string
  onInstall: () => void
}

export function updaterButtonState(
  state: UpdaterState | undefined,
  language: Pick<ReturnType<typeof useLanguage>, "t">,
  onInstall: () => void,
): UpdaterButtonState {
  const action = updaterAction(state)
  const version = state && "version" in state ? state.version : undefined
  return {
    visible: version !== undefined,
    busy: state?.status === "downloading" || state?.status === "installing",
    disabled: !action.run,
    label: language.t("titlebar.update"),
    ariaLabel: language.t(action.label),
    title:
      state?.status === "blocked"
        ? state.message
        : version
          ? language.t("titlebar.updateVersion", { version })
          : undefined,
    onInstall,
  }
}

export function UpdaterButton(props: { state: UpdaterButtonState }) {
  return (
    <div class="group relative mr-3 h-5 w-5 shrink-0 rounded-full bg-v2-background-bg-deep transition-[width] duration-150 ease-out hover:z-30 hover:w-[68px] focus-within:z-30 focus-within:w-[68px] motion-reduce:transition-none">
      <button
        type="button"
        data-action="desktop-update"
        class="absolute right-0 top-0 z-10 flex h-5 w-5 items-center justify-end overflow-hidden rounded-full bg-v2-icon-icon-accent/20 text-v2-icon-icon-accent transition-[width,background-color] duration-150 ease-out group-hover:w-[68px] group-hover:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] group-focus-within:w-[68px] group-focus-within:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] focus-visible:outline-none disabled:opacity-60 motion-reduce:transition-none [app-region:no-drag]"
        onClick={props.state.onInstall}
        disabled={props.state.disabled}
        aria-busy={props.state.busy}
        aria-label={props.state.ariaLabel}
        title={props.state.title}
      >
        <span
          aria-hidden="true"
          class="shrink-0 ml-[8px] mr-px text-[11px] text-v2-text-text-accent [font-weight:530] opacity-0 translate-x-2 motion-safe:transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-focus-within:opacity-100 group-focus-within:translate-x-0 motion-reduce:translate-x-0"
        >
          {props.state.label}
        </span>
        <span class="flex size-5 shrink-0 items-center justify-center">
          <Show
            when={!props.state.busy}
            fallback={
              <span
                data-slot="titlebar-update-loader"
                class="size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
                aria-hidden="true"
              />
            }
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128" stroke="currentColor" />
            </svg>
          </Show>
        </span>
      </button>
    </div>
  )
}
