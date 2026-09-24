// SPDX-License-Identifier: Apache-2.0
import type {
  LeLabCameraBridge,
  LeLabErrorCode,
  LeLabFrame,
  LeLabRobot,
} from "../../../physicalsystems/src/lelab-types"

/** Preview requests never become model messages or motor commands. Each start owns
 * a separate generation so an old response cannot enter another conversation. */
export function createLeLabPreview(
  bridge: LeLabCameraBridge,
  events: {
    robots(robots: LeLabRobot[], selected: string): void
    frame(id: string, frame: LeLabFrame): void
    error(id: string | undefined, code: LeLabErrorCode): void
    clear(): void
  },
) {
  let active: string | undefined
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const stop = () => {
    const previous = active
    active = undefined
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    events.clear()
    if (previous) void bridge.stop({ clientId: previous }).catch(() => undefined)
  }
  const start = async (url: string, selected: string) => {
    stop()
    const clientId = crypto.randomUUID()
    active = clientId
    const discovered = await bridge.discover({ url, clientId }).catch(() => undefined)
    if (active !== clientId) return
    if (!discovered?.ok) {
      events.error(undefined, discovered?.code ?? "UNAVAILABLE")
      return
    }
    const robots = discovered.value.robots
    const robot = selected ? robots.find((item) => item.name === selected) : robots.length === 1 ? robots[0] : undefined
    events.robots(robots, robot?.name ?? "")
    if (!robot) return
    for (const camera of robot.cameras) {
      if (!camera.previewAvailable) {
        events.error(camera.id, "UNSUPPORTED_CAMERA")
        continue
      }
      const poll = async () => {
        if (active !== clientId) return
        const result = await bridge
          .frame({ url: discovered.value.url, clientId, robotName: robot.name, cameraId: camera.id })
          .catch(() => undefined)
        if (active !== clientId) return
        if (result?.ok) events.frame(camera.id, result.value)
        else events.error(camera.id, result?.code ?? "UNAVAILABLE")
        // Sequential requests provide backpressure; busy devices retry slowly.
        const timer = setTimeout(
          () => {
            timers.delete(timer)
            void poll()
          },
          result?.ok ? 100 : 2000,
        )
        timers.add(timer)
      }
      void poll()
    }
  }
  return { start, stop }
}
