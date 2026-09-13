import { Button } from "@opencode-ai/ui/button"

export type UpdaterButtonState = {
  visible: boolean
  installing: boolean
  label: string
  ariaLabel: string
  title?: string
  onInstall: () => void
}
export function UpdaterButton(props: { state: UpdaterButtonState }) {
  return (
    <Button
      size="small"
      data-action="desktop-update"
      variant="secondary"
      icon={props.state.installing ? undefined : "download"}
      class="mr-2 shrink-0 [app-region:no-drag]"
      onClick={props.state.onInstall}
      disabled={props.state.installing}
      aria-busy={props.state.installing}
      aria-label={props.state.ariaLabel}
      title={props.state.title}
    >
      {props.state.label}
    </Button>
  )
}
