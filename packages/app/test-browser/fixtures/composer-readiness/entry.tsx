import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { Composer } from "../../../src/composer/composer"
import { SettingsProvider } from "../../../src/settings/model"
import { CommandProvider } from "../../../src/shell/commands/command"
import { createComposerEditor } from "../../../src/composer/editor/interaction"
import type { ComposerPersistedState } from "../../../src/composer/types"
import type { ModelSelection } from "../../../src/providers/models/selection"
import { PlatformProvider } from "../../../src/runtime/platform/platform"
import { LanguageProvider, UiI18nBridge } from "../../../src/runtime/i18n/language"
import { DialogProvider } from "@opencode/ui/context/dialog"

export function mount(root: HTMLElement) {
  const result: { update?: (patch: Record<string, unknown>) => void; dispose?: () => void } = {}
  result.dispose = render(() => {
    const [selected, setSelected] = createStore({
      agentId: "physical-systems",
      modelId: "fixture",
      providerId: "fixture",
      loading: false,
      paid: false,
      agentVisible: true,
      modelName: "A translated model label",
      agentName: "A translated agent label",
    })
    result.update = (patch) => setSelected(patch)
    const state = createStore<ComposerPersistedState>({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      cursor: 0,
      context: { items: [] },
    })
    const controller = createComposerEditor({
      store: state,
      commands: () => [],
      context: () => [],
      searchContextFiles: () => [],
      view: {
        get agent() {
          return selected.agentVisible
            ? {
                options: () => [
                  { id: "physical-systems", label: selected.agentName },
                  { id: "build", label: "Build" },
                ],
                current: () => selected.agentId,
                onSelect: (agentId: string) => setSelected({ agentId }),
              }
            : undefined
        },
        submit: { stopping: () => false, working: () => false, onSubmit() {}, onStop() {} },
      },
    })
    const model = {
      current: () =>
        selected.modelId && selected.providerId
          ? { id: selected.modelId, name: selected.modelName, provider: { id: selected.providerId } }
          : undefined,
      list: () => [],
      visible: () => true,
    } as unknown as ModelSelection
    return (
      <PlatformProvider value={{ platform: "web", openExternal() {}, async restart() {}, async notify() {} }}>
        <LanguageProvider locale="en">
          <UiI18nBridge>
            <DialogProvider>
              <SettingsProvider>
                <CommandProvider>
                  <Composer
                    model={{
                      ...controller,
                      model: {
                        selection: model,
                        get loading() {
                          return selected.loading
                        },
                        get paid() {
                          return selected.paid
                        },
                      },
                    }}
                  />
                </CommandProvider>
              </SettingsProvider>
            </DialogProvider>
          </UiI18nBridge>
        </LanguageProvider>
      </PlatformProvider>
    )
  }, root)
  return result as Required<typeof result>
}
