import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { OAuthBrowserLink } from "../../../src/components/oauth-browser-link"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"

export function mount(
  root: HTMLElement,
  open: (url: string) => Promise<boolean>,
  platform: "desktop" | "web" = "desktop",
) {
  const result: { update?: (url: string) => void; dispose?: () => void } = {}
  result.dispose = render(() => {
    const [state, setState] = createStore({ url: "https://example.com/authorize?state=first" })
    result.update = (url) => setState("url", url)
    return (
      <PlatformProvider value={{ platform, openExternal: open, async restart() {}, async notify() {} }}>
        <LanguageProvider locale="en">
          <OAuthBrowserLink url={state.url}>Sign in</OAuthBrowserLink>
        </LanguageProvider>
      </PlatformProvider>
    )
  }, root)
  return result as Required<typeof result>
}
