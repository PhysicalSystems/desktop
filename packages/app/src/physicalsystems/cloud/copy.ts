// SPDX-License-Identifier: Apache-2.0
/** Canonical English fallback; hosts can translate this finite embedded interface. */
export const cloudEnglish = {
  title: "Physical Systems",
  loading: "Loading conversation…",
  private: "Private conversation",
  team: "Team conversation",
  task: "Workcell context",
  useTaskDetails: "Use task details",
  taskDetailsHint: "Adds the saved task to an empty draft. Review it before sending.",
  taskDetailsPrompt: "Saved workcell details supplied by the user (not live observations):",
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
  messages: "Messages",
  earlier: "Load earlier messages",
  emptyMessages: "Send a message to this conversation. It will be available on your connected devices.",
  system: "System",
  member: "Member",
  catchingUp: "Loading messages sent while you were away…",
  aiHistory: "AI conversation",
  sendMode: "Message action",
  messageMode: "Message",
  aiMode: "Ask AI",
  messagePlaceholder: "Write a message…",
  messageHint: "Saved to this conversation and shared with its members. This does not ask AI or run the robot.",
  aiHint: "Sends this draft to the cloud assistant. Member messages are not automatically supplied as AI context.",
  memberLength: "Keep your message between 1 and 8,000 characters.",
  queued: "Your message is queued on this device. It will retry safely when connected; Retry checks the same send.",
  storageFailed: "This device could not save the draft or pending send. Keep a copy before leaving; sending is paused.",
} as const

export function cloudText(key: keyof typeof cloudEnglish) {
  return cloudEnglish[key]
}
