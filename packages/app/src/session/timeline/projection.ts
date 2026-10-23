import { createReactiveTimelineProjection } from "@opencode/session-ui/timeline/projection"
import type { TimelineDetail } from "@opencode/session-ui/timeline/detail"
import { createMemo, type Accessor } from "solid-js"
import { usePhysicalSystems } from "../../physicalsystems/context"

export { reuseTimelineRows } from "@opencode/session-ui/timeline/projection"

export function createTimelineDetail(preference: Accessor<TimelineDetail>) {
  const physical = usePhysicalSystems()
  return createMemo(() => {
    const detail = preference()
    return {
      shell: { ...detail.shell },
      edit: { ...detail.edit },
      thinking: { ...detail.thinking },
      subagents: { ...detail.subagents },
      notices: { ...detail.notices },
      // Physical Systems tool cards contain the operator's exact-plan approval;
      // a compact or text-only preference must not hide that required action.
      tools: physical?.enabled ? { placement: "separate" as const } : { ...detail.tools },
    }
  })
}

export function createTimelineProjection(input: Parameters<typeof createReactiveTimelineProjection>[0]) {
  return createReactiveTimelineProjection(input)
}
