import { createEffect, onCleanup, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { oauthBrowserURL } from "@/utils/oauth-attempt"
import { ExternalLink } from "./external-link"

/** Keep the current authorization link usable when the default browser cannot
 * be launched. An OS acknowledgement never means the account is signed in. */
export function OAuthBrowserLink(props: { url: string; children: JSX.Element; class?: string }) {
  const platform = usePlatform()
  const language = useLanguage()
  const [state, setState] = createStore({ opening: false, failed: false })
  const lifecycle = { revision: 0, alive: true }
  onCleanup(() => {
    lifecycle.alive = false
    lifecycle.revision++
  })
  const url = () => oauthBrowserURL(props.url)

  async function open(ticket = lifecycle.revision) {
    const target = url()
    if (!target || state.opening || !lifecycle.alive) return
    setState({ opening: true, failed: false })
    const opened = await Promise.resolve()
      .then(async () => await platform.openExternal(target))
      .catch(() => false)
    if (!lifecycle.alive || ticket !== lifecycle.revision) return
    setState({ opening: false, failed: opened !== true })
  }

  createEffect(() => {
    const target = url()
    lifecycle.revision++
    setState({ opening: false, failed: false })
    if (target && platform.platform === "desktop") untrack(() => void open(lifecycle.revision))
  })

  return (
    <Show when={url()} fallback={<span role="alert">{language.t("provider.connect.oauth.browser.invalid")}</span>}>
      {(target) => (
        <>
          <ExternalLink
            href={target()}
            class={props.class}
            aria-busy={state.opening}
            onClick={(event) => {
              if (platform.platform !== "desktop") return
              event.preventDefault()
              void open()
            }}
          >
            {props.children}
          </ExternalLink>
          <Show when={state.failed}>
            <span role="status" class="block mt-2">
              {language.t("provider.connect.oauth.browser.failed")}
            </span>
          </Show>
        </>
      )}
    </Show>
  )
}
