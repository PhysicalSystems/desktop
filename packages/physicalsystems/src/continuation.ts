// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"

export function continuationMessageId(requestId: string, sessionId: string) { return `msg_${createHash("sha256").update(JSON.stringify([sessionId, requestId])).digest("hex").slice(0, 32)}` }
function exactMessage(value: unknown, messageId: string, sessionId: string, text: string) {
  if (!value || typeof value !== "object") return false
  const record = value as { info?: { id?: string; sessionID?: string; role?: string; agent?: string }; parts?: { type: string; text?: string }[] }
  return record.info?.id === messageId && record.info.sessionID === sessionId && record.info.role === "user" && record.info.agent === "physical-systems" && Array.isArray(record.parts) && record.parts.length === 1 && record.parts[0].type === "text" && record.parts[0].text === text
}

/** HTTP acceptance alone is not durable admission. Unknown retries only inspect. */
export async function admitContinuation(input: { requestId: string; sessionId: string; text: string; retry?: boolean; signal?: AbortSignal }, io: { read(messageId: string, signal: AbortSignal): Promise<unknown>; post(messageId: string, signal: AbortSignal): Promise<void>; delay?(): Promise<void> }) {
  const messageId = continuationMessageId(input.requestId, input.sessionId)
  const signal = AbortSignal.any([AbortSignal.timeout(4000), ...(input.signal ? [input.signal] : [])])
  signal.throwIfAborted()
  const existing = await io.read(messageId, signal)
  if (existing !== undefined) {
    if (!exactMessage(existing, messageId, input.sessionId, input.text)) throw new Error("CONTINUATION_MESSAGE_CONFLICT")
    return { accepted: true, duplicate: true, requestId: input.requestId }
  }
  if (input.retry) throw new Error("CONTINUATION_UNCONFIRMED")
  signal.throwIfAborted()
  await io.post(messageId, signal)
  for (let attempt = 0; attempt < 12; attempt++) {
    signal.throwIfAborted()
    const admitted = await io.read(messageId, signal)
    if (admitted !== undefined) {
      if (!exactMessage(admitted, messageId, input.sessionId, input.text)) throw new Error("CONTINUATION_MESSAGE_CONFLICT")
      return { accepted: true, duplicate: false, requestId: input.requestId }
    }
    await (io.delay?.() ?? new Promise((resolve) => setTimeout(resolve, 100)))
  }
  throw new Error("CONTINUATION_UNCONFIRMED")
}
