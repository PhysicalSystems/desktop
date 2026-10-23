# Shared cloud conversation

`CloudConversation` reuses the existing Physical Systems/OpenCode `SessionTurn`, `PromptInputV2`, `normalizeSessionMessages` and `normalizeSessionInfo`. The native app mounts it directly with `conversation.css`. The website uses the source export's isolated same-origin frame, which imports the canonical style layers and exposes `window.physicalSystemsCloudConversation.mount(document.getElementById("app"), options)`.

Options are `accountKey`, `workcellId`, `conversationId`, `transport`, optional `theme` and optional authenticated `workcell` context. `accountKey` is a non-secret stable user identifier, never a token. The host must replace the transport and dispose/remount the view whenever authentication changes, including same-user token changes. `mount` returns `{dispose, update}`; identity or transport changes remount the entire conversation and cancel outstanding work. The host supplies no worker address, arbitrary route, filesystem path, provider/model setting or credentials to this UI.

The transport permits exactly:

- `GET /api/workcells/:workcellId/conversations/:conversationId/runtime` returning `CloudConversationSnapshot` from `types.ts`. Canonical `SessionInfo` and `SessionMessageInfo[]` come from the worker's projected `/api/session/:id/message` endpoint, not raw durable history or compacted provider context. `runtime.status` explicitly distinguishes `ready` and `unavailable`; a new ready conversation may have `session:null` and no messages.
- `POST /api/workcells/:workcellId/conversations/:conversationId/prompts` with `{requestId,text}`; text is 1–32,000 characters. Successful admission returns `{requestId,admitted:true}` with the exact request ID. Server-side authorization, idempotency and all worker execution restrictions remain mandatory.

Polling refreshes the snapshot every five seconds (1.5 seconds when busy), on focus and after an admitted prompt. Read-only access hides the composer. Lost access clears the rendered history and draft. Uncertain admission persists an account/conversation-bound request in session storage and offers an explicit exact retry; changing the message or silently replaying it is disallowed until resolved. HTTP 408/429/5xx preserve the request; definitive other 4xx resolve it. Browser transports must preserve safe error status/code and suppress stale account responses. No local shell, attachments, arbitrary tools or file previews are exposed.

Legacy saved workcell updates are a separate history. This component renders only canonical worker conversation records and never turns an update into an assistant response.
