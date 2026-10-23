import type { Platform } from "@opencode/app/desktop"
import { onMount } from "solid-js"
import physicalIcon from "../../../icons/physicalsystems/icon.png"

export function LoadingSplash(props: {
  deep: boolean
  firstLaunch: boolean
  platform: Platform
  preview: boolean
  onDrawEnd: () => void
}) {
  onMount(() => props.onDrawEnd())
  return (
    <div
      data-component="startup-splash"
      class="h-dvh w-screen flex flex-col items-center justify-center"
      classList={{ "bg-v2-background-bg-deep": props.deep, "bg-v2-background-bg-base": !props.deep }}
    >
      <img src={physicalIcon} alt="" class="size-20 animate-pulse" />
    </div>
  )
}
