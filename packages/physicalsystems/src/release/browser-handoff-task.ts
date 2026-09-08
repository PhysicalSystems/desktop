// SPDX-License-Identifier: Apache-2.0
import type { OwnedReviewBrowser } from "./owned-review-browser"
import { readBrowserObservation, type BrowserObservation } from "./browser-observation"

/** One exact read-only confirmation. Deadline cancellation prevents replacement
 * reads; draining finishes before the owning app callback permits cleanup. */
export function createBrowserHandoffTask(
  browser: Pick<OwnedReviewBrowser, "confirmHandoff" | "observation">,
  quiescenceTimeoutMs = 13000,
) {
  // The production Windows transport owns its execFile child and enforces a
  // 12s operation deadline plus at most 500ms to confirm close, within this
  // 13s drain. A rejected but unconfirmed close remains retained uncertainty.
  // CDP is bounded to 2s. Abort between reads keeps these budgets separate.
  if (!Number.isInteger(quiescenceTimeoutMs) || quiescenceTimeoutMs < 1 || quiescenceTimeoutMs > 13000)
    throw Error("PROVIDER_REVIEW_BROWSER_UNCONFIRMED")
  const cancellation = new AbortController()
  let task: Promise<boolean> | undefined
  let url: string | undefined
  let settled = false
  let nativeCloseUnconfirmed = false
  let draining: Promise<{ settled: boolean; observation: BrowserObservation }> | undefined
  return {
    confirm(value: string) {
      if (url !== undefined && url !== value) throw Error("PROVIDER_REVIEW_BROWSER_UNCONFIRMED")
      if (cancellation.signal.aborted) return Promise.resolve(false)
      url = value
      return (task ??= Promise.resolve()
        .then(() => {
          if (cancellation.signal.aborted) return false
          return browser.confirmHandoff(value, { signal: cancellation.signal })
        })
        .then((result) => result === true && !cancellation.signal.aborted)
        .catch((error) => {
          nativeCloseUnconfirmed = readBrowserObservation(error)?.handoffQuiescence === "unconfirmed"
          throw error
        })
        .finally(() => {
          settled = true
        }))
    },
    cancel() {
      cancellation.abort()
    },
    drain() {
      return (draining ??= (async () => {
        cancellation.abort()
        let timer: ReturnType<typeof setTimeout> | undefined
        if (task && !settled) {
          await Promise.race([
            task.then(
              () => {},
              () => {},
            ),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, quiescenceTimeoutMs)
            }),
          ])
          clearTimeout(timer)
        }
        const quiescent = (!task || settled) && !nativeCloseUnconfirmed
        const observation: BrowserObservation = { handoffQuiescence: quiescent ? "settled" : "unconfirmed" }
        const snapshot = readBrowserObservation({ browserObservation: browser.observation?.() })
        if (snapshot)
          for (const [key, value] of Object.entries(snapshot))
            if (key.startsWith("handoff")) Object.assign(observation, { [key]: value })
        observation.handoffQuiescence = quiescent ? "settled" : "unconfirmed"
        if (!quiescent) observation.handoffOutcome = "pending"
        return { settled: quiescent, observation: Object.freeze(observation) }
      })())
    },
  }
}
