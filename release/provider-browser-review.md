# Actual provider browser sign-in review

`runOwnedProviderBrowserReview` is an opt-in operation for a packaged application
on a disposable runner. No real provider call has been run to validate
this implementation. Unit tests use inert protocol callbacks and never qualify a
provider account. The public requirement remains `NOT_TESTED` until the native
controller executes this operation on the exact public artifact and confirms all
its process/profile/service cleanup.

## Supported operation

The current bundled V2 OpenAI plugin exposes `chatgpt-headless`, which starts the
real device authorization flow at `auth.openai.com`. The reviewer can authorize the
runner's fresh device code in their own browser. Its separate `chatgpt-browser`
method uses a callback bound to localhost:1455 on the app machine; opening that
link on another machine would not complete the runner's callback.

The V2 GitHub Copilot and Anthropic modules currently register SDK/catalog behavior,
not equivalent OAuth methods. Copilot's legacy OAuth implementation is not proof
that the actual V2 dialog supports it. This operation therefore accepts only an
explicit `openai-device` selection. Missing selection performs no provider request.
The account and provider choice still require the user's answer before dispatch.

## Native controller wiring

The lifecycle/upload wrapper is in
[`owned-provider-review.ts`](../packages/physicalsystems/src/release/owned-provider-review.ts).
It invokes the actual protocol in
[`provider-browser-review.ts`](../packages/physicalsystems/src/release/provider-browser-review.ts)
and its strict
[`provider-browser-transport.ts`](../packages/physicalsystems/src/release/provider-browser-transport.ts).

1. Use the exact independently verified installer and a fresh exclusive profile,
   with device access disabled. Preserve source, release-input and artifact digests
   plus run ID, run attempt and platform in the review context. Prepare a fresh
   random 32-byte hex nonce in the controller; do not print or upload it.
2. Before launching the app, opt in with `PHYSICALSYSTEMS_PROVIDER_REVIEW=openai-device`,
   `PHYSICALSYSTEMS_PROVIDER_REVIEW_NONCE=<nonce>` and the existing qualification
   trace flag. Keep those values out of ordinary profiles. Main's actual native
   provider-vault acknowledgment calls `providerAccountTrace`; operator credentials
   never enter that hook. Tests verify ordinary app use emits no account diagnostics.
3. Verify the launched process and attachment through the existing native ownership
   checks. Construct `providerBrowserReviewTransport(attachment)`. It accepts only
   the actual OpenAI V2 integration/OAuth/credential routes, binds the exact Location,
   disables redirects, bounds responses and requires exact HTTP success statuses.
4. The wrapper calls `runProviderBrowserReview` with the owned child process, transport, anchored
   context, nonce, reviewer RSA public key and independently expected public-key
   SHA-256. Supply `openBrowser(url)` by evaluating the actual owned renderer's
   `window.api.openExternal(url)` and preserving its boolean acknowledgment.
   Provision a genuine browser/system launcher for this separate QA phase. The
   ordinary no-Node/Bun-PATH self-containment check must retain its original scope;
   an empty-PATH launcher failure is not evidence of successful browser handoff.
5. The wrapper supplies `publishChallenge(bytes)` and the existing desktop-pinned
   `@actions/artifact` client to upload only the encrypted challenge while
   this same native controller remains alive and polls the exact attempt. Never
   upload plaintext instructions or a profile. The recipient's RSA key stays solely
   with the reviewer. AES-256-GCM and RSA-OAEP-SHA256 bind the ciphertext to the exact
   run, attempt, source, artifact, nonce digest, recipient and expiry. Decryption
   must compare this context with independently expected values before displaying
   the URL/code privately. Only that device code authorizes that pending attempt;
   there is no user-supplied PASS receipt or arbitrary account assertion.
6. The helper requires actual native browser acknowledgment, the same V2 attempt
   becoming complete, exactly one sanitized connection, and matching native WRITE
   and READ account fingerprints for that credential. Fingerprints salt the actual
   provider account ID with the private nonce, integration ID and credential ID.
   Raw account IDs and OAuth tokens never enter traces or receipts. The READ marker
   follows actual vault decryption, not a model/renderer assertion.
7. The helper cancels the exact attempt, removes the owned temporary credential,
   and confirms the integration is disconnected on success and failure. Unknown
   removal fails with a fixed cleanup error. The caller then confirms shutdown and
   discards its exclusive profile/private services. Local credential deletion does
   not assert revocation of a provider-issued grant.

The returned `OBSERVED` record contains context, encrypted-challenge hash, nonce
digest, recipient fingerprint, attempt hash and salted account fingerprint, plus
actual handoff, persistence/retrieval and local-removal facts. It is not a public
native qualification receipt. Only the reviewed native controller may map these
facts plus its independently observed cleanup to `native-provider-browser-probe`.
No helper import accepts a manual PASS object. Provider model inference, quota,
subscription compatibility, provider-side token revocation and a second account
remain separately untested.

## Executable native lifecycle

The optional workflow inputs are `provider_qa` (`disabled` by default, or the
explicit `openai-device` choice), `provider_qa_public_key` and
`provider_qa_key_sha256`. The latter is the independently checked SHA-256 of the
RSA public key's DER SPKI bytes. A selected provider is still required before
dispatch; an absent answer or an existing diagnostics key does not authorize an
account sign-in.

The native step passes `PS_PROVIDER_REVIEW`, `PS_PROVIDER_REVIEW_PUBLIC_KEY_PEM`,
`PS_PROVIDER_REVIEW_KEY_SHA256` and `PHYSICALSYSTEMS_PROVIDER_REVIEW_SOURCE_SHA`.
It invokes the local [`provider-review-runtime`](../.github/actions/provider-review-runtime/action.yml)
Node action, using fixed mode `candidate` or `public`. The action runs the existing
native qualifier under Xvfb on Linux. GitHub's Node-action runtime supplies artifact
service credentials directly; the action never writes those credentials to
`GITHUB_ENV`, command arguments, profiles or public evidence. The wrapper resolves
the existing pinned desktop artifact SDK, rather than a transitive workspace copy.

The exact native integration is:

```ts
await runOwnedProviderBrowserReview({
  env: process.env, // controller only
  root: exclusiveEmptyPhaseDirectory,
  artifact: independentlyVerifiedInstaller,
  context: { runId, runAttempt, sourceRevision, artifactSha256, releaseInputsSha256, platform },
  runtimeEnvironment: scrubbedQualificationEnvironment,
  async withSession(environment, review) {
    // Existing owned native controller launches the exact app with environment.
    // Invoke review({ child, attachment, openBrowser }) after attachment/renderer
    // verification and before any model prompt. openBrowser calls this renderer's
    // window.api.openExternal(url) and returns the actual boolean acknowledgment.
    // Return the callback result only after native finally cleanup is confirmed.
    return await existingOwnedNativeSession(environment, review)
  },
})
```

The wrapper independently checks the installer SHA-256 and run/source/input anchors.
It owns a fresh nonce, uploads one exclusive ciphertext file with one-day retention
and records the returned artifact ID/archive hash. The archive is available while
that same controller polls the still-live attempt. The reviewer downloads only
that archive from the exact running workflow and decrypts it privately, checking
the expected run, attempt, source, installer, recipient fingerprint and expiry
before entering its device code on the official URL. The RSA private key never
goes to GitHub. No code or token is printed in Actions logs.

The Linux browser controller starts the runner's installed Google Chrome in an
exclusive profile and process session. Its private XDG handler reuses that profile
when the app calls the actual native opener. The controller observes a provider
tab through that owned browser's loopback CDP endpoint, then verifies owned process
exit and removes the profile. The runtime PATH is explicitly available for this
separate browser phase; the earlier empty-PATH application checks remain unchanged.
Chrome's [profile argument](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md)
and its separate Linux Crash Reports directory are accounted for. Raw browser
output, profiles and arbitrary process command lines are never uploaded.

Windows returns `BLOCKED / BROWSER_OWNERSHIP_UNAVAILABLE` before any provider call.
The Windows default-browser handoff currently lacks reviewed ownership/profile
cleanup; an OS acknowledgment alone is insufficient. Failed or uncertain native
startup/cleanup retains private paths and prevents an observed-success return.
No original profile or OS default-browser registry entry is modified.

## Timing and current evidence

Authorization is bounded by the earlier of the provider attempt expiry and nine
minutes. Individual sidecar calls are bounded to 6.5 seconds, browser acknowledgment
to six seconds and encrypted upload to thirty seconds. Cleanup remains bounded
after timeout. Polling does not restart or retry authentication automatically.

The existing producer has no selected real account or reviewer key provisioned.
The executable wrapper/action has only inert automated test evidence. Native
integration must still be exercised on the exact selected artifact after a real
account choice. An artifact uploaded only after its controller exits cannot support this flow.
The helper does not expose a public callback server, tunnel the runner, put a code
in Actions logs, or grant qualification from an encrypted fixture challenge.
