// SPDX-License-Identifier: Apache-2.0

const methods = {
  integration: "GET",
  "key-write": "POST",
  "credential-remove": "DELETE",
  catalog: "GET",
  active: "GET",
  "session-read": "GET",
  "model-switch": "POST",
  prompt: "POST",
} as const

export type V2TransportObservation = {
  routeKind: keyof typeof methods
  method: "GET" | "POST" | "DELETE"
  status?: number
  envelopeValid?: boolean
  locationMatched?: boolean
  outcome: "pending" | "response" | "accepted" | "rejected"
}

/** Retain only the last authored transport checkpoint. Request URLs, bodies,
 * headers, errors and arbitrary server values never enter this observation. */
export function createV2TransportObservation() {
  let last: Readonly<V2TransportObservation> | undefined
  return {
    observe(value: unknown) {
      // A malformed new observation must not leave a stale accepted result.
      last = undefined
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("V2_CREDENTIAL_PROBE_OBSERVATION_INVALID")
      const input = value as Record<string, unknown>
      if (
        typeof input.routeKind !== "string" ||
        !Object.hasOwn(methods, input.routeKind) ||
        input.method !== methods[input.routeKind as keyof typeof methods] ||
        typeof input.outcome !== "string" ||
        !["pending", "response", "accepted", "rejected"].includes(input.outcome) ||
        (input.status !== undefined &&
          (!Number.isInteger(input.status) || Number(input.status) < 100 || Number(input.status) > 599)) ||
        (input.envelopeValid !== undefined && typeof input.envelopeValid !== "boolean") ||
        (input.locationMatched !== undefined && typeof input.locationMatched !== "boolean")
      )
        throw new Error("V2_CREDENTIAL_PROBE_OBSERVATION_INVALID")
      last = Object.freeze({
        routeKind: input.routeKind as V2TransportObservation["routeKind"],
        method: input.method as V2TransportObservation["method"],
        ...(input.status === undefined ? {} : { status: input.status as number }),
        ...(input.envelopeValid === undefined ? {} : { envelopeValid: input.envelopeValid as boolean }),
        ...(input.locationMatched === undefined ? {} : { locationMatched: input.locationMatched as boolean }),
        outcome: input.outcome as V2TransportObservation["outcome"],
      })
    },
    snapshot: () => last,
  }
}
