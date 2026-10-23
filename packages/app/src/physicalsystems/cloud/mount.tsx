// SPDX-License-Identifier: Apache-2.0
import { createMemo, Show } from "solid-js"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { resolveThemeVariant, themeToCss } from "@opencode-ai/ui/theme/resolve"
import type { DesktopTheme } from "@opencode-ai/ui/theme/types"
import { resolveThemeVariantV2, themeV2ToCss } from "@opencode-ai/ui/theme/v2/resolve"
import theme from "../../../../ui/src/theme/themes/oc-2.json"
import { CloudConversation } from "./conversation"
import type { CloudConversationOptions } from "./types"
import "./cloud.css"
export type { CloudConversationOptions, CloudConversationSnapshot, CloudPromptAdmission } from "./types"
export type { WorkcellRoomData } from "../rooms/types"

/** Mount in the host's isolated frame document to keep canonical styles and portals together. */
export function mountCloudConversation(element: HTMLElement, options: CloudConversationOptions) {
  const [state, setState] = createStore(options)
  const dispose = render(() => {
    const identity = createMemo(() => ({
      accountKey: state.accountKey,
      workcellId: state.workcellId,
      conversationId: state.conversationId,
      transport: state.transport,
    }))
    const css = createMemo(() => {
      const dark = state.theme === "dark"
      const variant = (theme as DesktopTheme)[dark ? "dark" : "light"]
      return `${themeToCss(resolveThemeVariant(variant, dark))}\n${themeV2ToCss(resolveThemeVariantV2(variant, dark))}`
    })
    return (
      <div class="ps-cloud-root">
        <style>{`:root {${css()}}`}</style>
        <Show when={identity()} keyed>
          {(identity) => <CloudConversation {...state} {...identity} />}
        </Show>
      </div>
    )
  }, element)
  return { dispose, update: (next: Partial<CloudConversationOptions>) => setState(next) }
}
