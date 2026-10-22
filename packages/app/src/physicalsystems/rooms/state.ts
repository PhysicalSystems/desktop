// SPDX-License-Identifier: Apache-2.0
import type { WorkcellRoomData } from "./types"
import { roomText } from "./copy"
/** Never apply a response from a previous room, or roll a room back after a delayed request. */
export function acceptsRoom(current: WorkcellRoomData | undefined, next: WorkcellRoomData, id: string) {
  return (
    next?.id === id &&
    Number.isSafeInteger(next.lastEventSequence) &&
    next.lastEventSequence >= 0 &&
    (!current || current.id !== next.id || next.lastEventSequence >= current.lastEventSequence)
  )
}
export function workcellPath(id: string) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("INVALID_WORKCELL_ID")
  return `/api/workcells/${encodeURIComponent(id)}`
}
export function roomResourceHref(href: string) {
  return /^\/(?!\/)[A-Za-z0-9/_?=&%-]*$/.test(href) ? href : undefined
}
export function roomAccessDenied(error: unknown) {
  const value = error as { status?: number; code?: string; message?: string } | undefined
  return (
    [401, 403, 404].includes(value?.status ?? 0) ||
    /ACCESS_REVOKED|WORKCELL_SIGN_IN_REQUIRED|WORKCELL_SESSION_CHANGED/.test(value?.code ?? value?.message ?? "")
  )
}
export function prepareTaskPrompt(room: WorkcellRoomData) {
  const fields = {
    name: room.name,
    company: room.companyName ?? "",
    task: room.task,
    objects: room.objects,
    volume: room.volume,
    location: room.location,
  }
  const render = (fraction: number) =>
    `${roomText("promptInstruction")}${fraction < 1 ? `\n${roomText("promptExcerpt")}` : ""}\n\n${JSON.stringify(
      {
        workcellId: room.id,
        ...Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, value.slice(0, Math.floor(value.length * fraction))]),
        ),
        room: `https://physicalsystems.ai/dashboard/workcells/${encodeURIComponent(room.id)}`,
      },
      null,
      2,
    )}`
  // The existing browser Assistant accepts 2,000 characters. Preserve its API contract,
  // and keep the complete task in the room rather than silently sending an oversized draft.
  if (render(1).length <= 2000) return render(1)
  let low = 0
  let high = 1
  for (let iteration = 0; iteration < 32; iteration++) {
    const middle = (low + high) / 2
    if (render(middle).length <= 2000) low = middle
    else high = middle
  }
  return render(low)
}
