// SPDX-License-Identifier: Apache-2.0
/** Canonical English fallback; hosts can translate this finite embedded interface. */
export const cloudEnglish = {
  title: "Physical Systems",
  loading: "Loading conversation…",
  private: "Private conversation",
  team: "Team conversation",
  task: "Workcell context",
  empty: "Start a conversation about this workcell.",
  placeholder: "Ask about your workcell…",
  unavailable: "The cloud assistant is not available yet. Your saved conversation is still here.",
  readonly: "You can read this conversation. Posting requires operator access.",
  denied: "Access to this conversation has changed. Return to your workcells and sign in again.",
  failed: "The conversation could not be refreshed. The last loaded messages are shown.",
  retry: "Retry",
  unconfirmed: "Your message has not been confirmed. Retry sends the same message once.",
  invalid: "This conversation response could not be verified.",
  length: "Keep your message between 1 and 32,000 characters.",
  promptFailed: "Your message was not accepted. Review it and try again.",
  sending: "Sending…",
} as const

export function cloudText(key: keyof typeof cloudEnglish) {
  return cloudEnglish[key]
}
