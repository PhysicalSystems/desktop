import type { WorkcellAccountBridge } from "../../../physicalsystems/src/workcell-account-types"

export type WorkcellRequestResult = { ok: true; value: unknown } | { ok: false; error: string; status?: number }

export type NativeWorkcellAccountBridge = Omit<WorkcellAccountBridge, "request"> & {
  request(...args: Parameters<WorkcellAccountBridge["request"]>): Promise<WorkcellRequestResult>
}

/** Reconstruct errors after Electron has serialized the bounded native reply. */
export function workcellAccountBridge(native: NativeWorkcellAccountBridge): WorkcellAccountBridge {
  return {
    ...native,
    async request(...args) {
      const result = await native.request(...args)
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error, status: result.status })
      return result.value
    },
  }
}
