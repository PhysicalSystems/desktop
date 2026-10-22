// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource solid-js */
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { WorkcellRoom } from "./room"
import type { WorkcellRoomOptions } from "./types"
export { prepareTaskPrompt } from "./state"
export type { WorkcellRoomOptions, WorkcellTransport } from "./types"
export function mountWorkcellRoom(element: HTMLElement, options: WorkcellRoomOptions) {
  const [state, setState] = createStore(options)
  const dispose = render(() => <WorkcellRoom {...state} />, element)
  return { dispose, update: (next: Partial<WorkcellRoomOptions>) => setState(next) }
}
