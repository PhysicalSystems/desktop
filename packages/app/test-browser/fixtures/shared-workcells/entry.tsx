import { render } from "solid-js/web"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { PlatformProvider } from "../../../src/runtime/platform/platform"
import { LanguageProvider } from "../../../src/runtime/i18n/language"
import { NativeCloudConversations } from "../../../src/physicalsystems/conversations-native"
import type { WorkcellAccountBridge } from "../../../../../physicalsystems/src/workcell-account-types"

export function mount(root: HTMLElement, bridge: WorkcellAccountBridge) {
  const control = { local: false, settings: false, ai: false, opened: [] as string[] }
  const dispose = render(
    () => (
      <PlatformProvider
        value={{
          platform: "desktop",
          openExternal(url) {
            control.opened.push(url)
          },
          async restart() {},
          async notify() {},
        }}
      >
        <LanguageProvider locale="en">
          <ThemeProvider>
            <NativeCloudConversations
              bridge={bridge}
              close={() => {
                control.local = true
              }}
              openSettings={() => {
                control.settings = true
              }}
              switchAccountMode={() => {
                control.ai = true
              }}
            />
          </ThemeProvider>
        </LanguageProvider>
      </PlatformProvider>
    ),
    root,
  )
  return { dispose, control }
}
