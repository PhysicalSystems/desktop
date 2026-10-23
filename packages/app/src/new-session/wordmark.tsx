import { Show } from "solid-js"
import { usePhysicalSystems } from "@/physicalsystems/context"
import { useLanguage } from "@/runtime/i18n/language"
import { Logo } from "@opencode/ui/logo"
import "./wordmark.css"

export function NewSessionWordmark() {
  const physical = usePhysicalSystems()
  const language = physical?.enabled ? useLanguage() : undefined
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      class="pointer-events-none mx-auto w-full max-w-[720px] text-v2-background-bg-inverse"
    >
      <Show
        when={physical?.enabled}
        fallback={
          <div data-slot="wordmark-reveal" class="relative mx-auto w-4/5">
            <Logo class="block aspect-[720/129] w-full opacity-[0.16]" />
            <Logo class="wordmark-shimmer absolute inset-0 aspect-[720/129] w-full" />
          </div>
        }
      >
        <div class="text-center text-[clamp(28px,5vw,60px)] font-bold tracking-tight opacity-20">
          {language?.t("physicalsystems.name")}
        </div>
      </Show>
    </div>
  )
}
