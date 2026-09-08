import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { ProviderConnection } from "../../../src/components/dialog-connect-provider"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
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
                  <ProviderConnection
                    provider="fixture"
                    directory={() => "/owned-project"}
                    onBack={() => {
                      control.exited = true
                    }}
                    setBack={(back) => {
                      control.back = back
                    }}
                  />
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
