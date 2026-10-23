import { Root } from "@kobalte/core/dialog"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { ProviderConnection } from "../../../src/providers/connect/dialog"
import { PlatformProvider } from "../../../src/runtime/platform/platform"
import { LanguageProvider } from "../../../src/runtime/i18n/language"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { fixture } from "./environment"

export function mount(
  root: HTMLElement,
  api: Record<string, unknown>,
  open: (url: string) => Promise<boolean>,
  layout = true,
) {
  fixture.api = api
  fixture.layout = layout
  fixture.toasts = []
  fixture.refreshes = 0
  const control = { back() {}, exited: false }
  const dispose = render(
    () => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <PlatformProvider
              value={{ platform: "desktop", openExternal: open, async restart() {}, async notify() {} }}
            >
              <LanguageProvider locale="en">
                <DialogProvider>
                  <Root open>
                    <ProviderConnection
                      provider="fixture"
                      directory="/owned-project"
                      onAuthorization={() => {}}
                      onFirstConnection={() => {}}
                      onBack={() => {
                        control.exited = true
                      }}
                      setBack={(back) => {
                        control.back = back
                      }}
                    />
                  </Root>
                </DialogProvider>
              </LanguageProvider>
            </PlatformProvider>
          )}
        />
      </MemoryRouter>
    ),
    root,
  )
  return { control, dispose, fixture }
}
