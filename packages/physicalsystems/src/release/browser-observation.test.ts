// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { browserObservationError, browserSyscallFailure, readBrowserObservation } from "./browser-observation"

test("browser failure keeps only fixed phase/count metadata through cleanup wrappers", () => {
  const startup = browserObservationError("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED", Error("PRIVATE-CONTENT"), {
    browserPhase: "cleanup-identity",
    failedBrowserPhase: "identity-executable",
    cleanupFailurePhase: "cleanup-identity",
    pidObserved: true,
    birthVerified: false,
    cdpReady: false,
    syscallFailure: "EACCES",
  })
  const wrapped = browserObservationError("BROWSER_HANDOFF_CLEANUP_UNCONFIRMED", startup, {
    reviewPhase: "browser-cleanup",
    failedReviewPhase: "browser-acquisition",
    openerAcknowledged: false,
    requestObserved: false,
  })
  expect(wrapped.message).toBe("BROWSER_HANDOFF_CLEANUP_UNCONFIRMED")
  expect(readBrowserObservation(wrapped)).toEqual({
    ...readBrowserObservation(startup),
    reviewPhase: "browser-cleanup",
    failedReviewPhase: "browser-acquisition",
    openerAcknowledged: false,
    requestObserved: false,
  })
  expect(JSON.stringify(readBrowserObservation(wrapped))).not.toContain("PRIVATE")
  expect(Object.isFrozen(readBrowserObservation(wrapped))).toBe(true)
  expect(browserSyscallFailure({ code: "EACCES" })).toBe("EACCES")
  expect(browserSyscallFailure({ code: "PRIVATE" })).toBe("OTHER")
})

test("unknown fields/values, URLs, unsafe counts and getter failures cannot enter browser receipts", () => {
  for (const browserObservation of [
    { browserPhase: "ready", url: "PRIVATE" },
    { browserPhase: "PRIVATE" },
    { browserPhase: "ready", targetCount: -1 },
    { browserPhase: "ready", targetCount: 65537 },
    { browserPhase: "ready", targetCount: 1.5 },
    { browserPhase: "ready", cdpReady: "true" },
    { browserPhase: "ready", syscallFailure: "PRIVATE" },
    {},
    [],
    null,
  ])
    expect(readBrowserObservation({ browserObservation })).toBeUndefined()
  expect(
    readBrowserObservation({
      get browserObservation() {
        throw Error("PRIVATE")
      },
    }),
  ).toBeUndefined()
})
