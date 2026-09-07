# Packaged native credential probe

`createNativeCredentialProbe()` in
[`native-credentials.ts`](../packages/physicalsystems/src/release/native-credentials.ts)
provides reusable observations for the packaged native credential test. Its unit
tests use a deliberate test cipher, fake HTTP callbacks and a local inert HTTP
fixture. **Passing those helper tests is not native qualification.** The packaged
smoke now runs the three real process phases below on disposable CI runners; its
`native-credential-probe` check passes only after all phases and shutdowns finish.
No local Electron application or live keyring is used to validate the helper code.

The production boundary remains unchanged. The current v1 compatibility adapter
uses `PUT /auth/:providerID` and `DELETE /auth/:providerID`. The sidecar's Auth
service routes through the authenticated operator gateway and Electron main's
`createCredentialVault(..., safeStorage)`. There is no production credential-read
or debug endpoint. The existing vault refuses unavailable encryption and Linux
`basic_text`; keep those checks intact.

## Exact packaged integration

Use one fresh owned profile and the exact already-hashed package. Keep device
connections disabled throughout. The controller owns the canary probe, inert
provider and app processes; receipts receive booleans, hashes and a fixed backend
label only. Each stdout/stderr stream is filtered for the canary across chunk
boundaries before it reaches the appended private application log.

1. Give the inert provider a dedicated chat-completions route for
   `probe.providerID`. Configure that provider with its loopback URL and fixture
   model, **without `options.apiKey`, authorization headers or an environment key**.
   Keep the ordinary simulation provider separate so background title requests
   cannot interfere with the credential observations.
2. Launch the packaged app and confirm its normal readiness/isolation checks.
   Load its owned runtime attachment privately. Adapt the existing authenticated
   sidecar request function to accept PUT/DELETE and pass the helper's abort signal.
   It must return parsed JSON, not a Response or a truthy wrapper. Never log request
   bodies or the attachment password.
3. Call `probe.save(request)`. It writes only the inert canary through the existing
   auth API and requires its exact `true` acknowledgement within 6.5 seconds.
   A timeout or transport failure is unconfirmed; do not retry or continue testing
   as if the mutation failed cleanly.
4. Call `probe.inspectFiles(profile)`. It requires a nonempty regular
   `operator/provider-credentials.enc`, excludes the canary's UTF-8 and UTF-16 bytes,
   checks that no atomic-write temporary remains, and requires the legacy fallback
   `data/opencode/auth.json` to remain absent. These are file observations, not
   proof of an OS encryption backend by themselves.
5. Confirm application and observed descendant shutdown, operation cleanup and
   runtime-attachment removal using the existing lifecycle checks. Do not proceed
   on an unconfirmed outcome. Restart the same executable and same profile; verify
   a new owned process and a new private attachment. Do not carry a sidecar auth
   object/cache from the first process into the second.
6. Call `probe.beginObservation("present")` and submit its returned nonce prompt to
   the dedicated fixture model through the ordinary model/session API. The fixture
   passes its parsed user messages and authorization header to
   `probe.observeProviderRequest(...)`, then returns a fixed inert text response.
   It must not log/store the header or return it to the model. Only this nonce's
   requests count; `probe.finishObservation()` requires the exact canary header.
   This proves retrieval through existing app behavior after the separately verified
   restart. No GET-auth or credential-reading test endpoint is necessary.
7. Call `probe.remove(request)` and inspect the files again. Clear the model's
   existing instance cache through its normal disposal behavior, preferably repeat
   the confirmed quit/relaunch. Submit a new `beginObservation("absent")` nonce.
   The dedicated fixture must observe a request without any authorization header;
   no request or a reused/cached canary is **unconfirmed**, not a pass. If the actual
   SDK refuses to make an unauthenticated request, retain that limit and design an
   existing-behavior removal probe before claiming removal verification.
8. Stop all owned processes and the fixture. Retain only exact package/source/input
   identifiers, the observed native backend, file-observation hashes, retrieval/
   removal booleans and confirmed lifecycle results. Keep profiles, canaries,
   attachment files, keyrings and HTTP bodies out of artifacts.

Actual integration should emit a native credential PASS only when all those real
observations succeed. The helper deliberately has no PASS field, no application
launch method and no mechanism for the caller to assert that a restart happened.
A fixed optional main-process trace records the selected backend only after a
successful provider-vault write. Windows requires `windows_dpapi`; the controlled
Linux session requires `gnome_libsecret`. Missing, mixed or other backend evidence
fails this probe. The first successful synthetic journey remains unchanged; the
next two launches reuse its profile and conversation without additional trials.
NSIS and Debian then run a fourth read-only launch after a same-byte
[uninstall/reinstall persistence probe](installed-reinstall.md); AppImage retains
the three credential phases only.

This auxiliary smoke check does not replace the public native receipt. The
collector still requires all eight public native checks from trusted reviewed
job evidence. Public smoke remains UNQUALIFIED; no candidate observation can be
copied into a public native PASS.

## Disposable Linux session

The candidate workflow installs `dbus`, `gnome-keyring` and `libglib2.0-bin` beside
its existing `libsecret-1-0` and Xvfb dependencies. A client library alone does not
provide an unlocked Secret Service.

The controller starts one owned private D-Bus daemon and one owned foreground
GNOME keyring daemon across the credential phases and the optional reinstall
launch. Private runtime, keyring
and control directories live under the disposable runner's temporary directory.
A generated nonempty test password travels over the daemon's stdin only. The
helper verifies the private bus and Secret Service process ownership before
returning the fixed GNOME environment. It does not reuse an ambient bus/keyring,
start SSH components, use plaintext storage, or replace another service.

The packaged process receives only the owned bus/runtime and fixed GNOME desktop
context in addition to its existing isolated environment. The service does not
change the app's separately owned native TMPDIR. After confirmed application and
descendant shutdown, the controller closes only its owned keyring and bus with
bounded exit checks. Unconfirmed cleanup fails qualification; service output,
passwords, keyring files, provider keys and profiles are never uploaded.

The daemon modes and stdin unlock protocol are defined by the
[GNOME implementation](https://gnome.pages.gitlab.gnome.org/gnome-keyring/coverage/daemon/gkd-main.c.gcov.html)
and [distribution manual](https://manpages.debian.org/unstable/gnome-keyring/gnome-keyring-daemon.1.en.html).
This controlled native credential check does not qualify a default desktop,
compositor, provider browser login, user logout/login, or physical display.

The smoke child has a ten-minute overall deadline for its bounded launches;
auth writes remain bounded to 6.5 seconds and each nonce request to 30 seconds.
Public qualification must rerun the real probe for each exact public installer.
