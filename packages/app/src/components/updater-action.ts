import { createMemo } from "solid-js"
import type { UpdaterState } from "@/updater"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function updaterAction(state: UpdaterState | undefined) {
  if (!state) return { label: "settings.updates.action.checkNow" as const }
  switch (state.status) {
    case "checking":
      return { label: "settings.updates.action.checking" as const }
    case "available":
      return {
        label:
          state.mode === "preview"
            ? ("settings.updates.action.update" as const)
            : ("settings.updates.action.download" as const),
        run: "download" as const,
      }
    case "downloading":
      return { label: "settings.updates.action.downloading" as const }
    case "ready":
      return { label: "toast.update.action.installRestart" as const, run: "install" as const }
    case "installing":
      return { label: "settings.updates.action.installing" as const }
    case "disabled":
      return { label: "settings.updates.action.checkNow" as const }
    case "blocked":
      if (state.recoverable) return { label: "settings.updates.action.recover" as const, run: "recover" as const }
      return { label: "settings.updates.action.attention" as const }
    default:
      return { label: "settings.updates.action.checkNow" as const, run: "check" as const }
  }
}

export function useUpdaterAction() {
  const platform = usePlatform()
  const language = useLanguage()
  const action = createMemo(() => updaterAction(platform.updater?.state()))

  return {
    action,
    description() {
      const state = platform.updater?.state()
      if (state?.status === "blocked" || state?.status === "error") return state.message
      return language.t(
        state?.mode === "preview" ? "settings.updates.preview.description" : "settings.updates.row.check.description",
      )
    },
    async run() {
      const run = action().run
      try {
        if (run === "install") return await platform.updater?.install()
        if (run === "recover") return await platform.updater?.recover?.()
        if (run !== "check" && run !== "download") return

        const state = await platform.updater?.[run]()
        if (run === "download" && state?.status === "ready" && state.mode === "preview") {
          return await platform.updater?.install()
        }
        if (state?.status === "up-to-date") {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
        }
        if (state?.status === "error") {
          showToast({ title: language.t("common.requestFailed"), description: state.message })
        }
      } catch {
        showToast({
          title: language.t("common.requestFailed"),
          description: language.t("settings.updates.toast.failed.description"),
        })
      }
    },
  }
}
