import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { PromptInputV2 } from "@opencode-ai/session-ui/v2/prompt-input"
import { createPromptInputV2Controller } from "@opencode-ai/session-ui/v2/prompt-input/interaction"
import type { PromptInputV2PersistedState } from "@opencode-ai/session-ui/v2/prompt-input/types"
import { PromptInputV2ModelControl } from "../../../src/components/prompt-input-v2"
import type { ModelSelection } from "../../../src/context/local"
import { PlatformProvider } from "../../../src/context/platform"
import { LanguageProvider } from "../../../src/context/language"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"

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
    const state = createStore<PromptInputV2PersistedState>({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      cursor: 0,
      context: { items: [] },
    })
    const controller = createPromptInputV2Controller({
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
          <DialogProvider>
            <PromptInputV2
              controller={controller}
              modelControl={
                <PromptInputV2ModelControl
                  loading={selected.loading}
                  paid={selected.paid}
                  title="Choose fixture model"
                  keybind={[]}
                  model={model}
                  providerID={selected.providerId}
                  modelName={selected.modelName}
                  onClose={() => {}}
                  onUnpaidClick={() => {}}
                />
              }
            />
          </DialogProvider>
        </LanguageProvider>
      </PlatformProvider>
    )
  }, root)
  return result as Required<typeof result>
}
