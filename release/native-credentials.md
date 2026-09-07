# Packaged native credential probe: integration proposal

`createNativeCredentialProbe()` in
[`native-credentials.ts`](../packages/physicalsystems/src/release/native-credentials.ts)
implements only the reusable observations for a native credential test. Its unit
tests use a deliberate test cipher and fake HTTP callbacks. **No native credential
qualification has passed because these helper tests pass.** The packaged-smoke
and workflow integration described below has not been applied or run.

The production boundary remains unchanged. The current v1 compatibility adapter
uses `PUT /auth/:providerID` and `DELETE /auth/:providerID`. The sidecar's Auth
service routes through the authenticated operator gateway and Electron main's
`createCredentialVault(..., safeStorage)`. There is no production credential-read
or debug endpoint. The existing vault refuses unavailable encryption and Linux
`basic_text`; keep those checks intact.

## Exact packaged integration

Use one fresh owned profile and the exact already-hashed package. Keep device
connections disabled throughout. The controller owns the canary probe, inert
provider and app processes; the public receipt receives booleans and hashes only.

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
Its nonce observations can also test the missing-keyring error path: a refused
save must leave no new vault or plaintext fallback; that negative-path result does
not satisfy the positive native credential requirement.

## Disposable Linux session proposal

The existing workflow installs `libsecret-1-0`, which supplies a client library,
not an unlocked Secret Service. The native probe needs a real isolated service.
Proposed workflow additions, on the disposable hosted Linux runner only:

1. Add `dbus`, `gnome-keyring` and `libglib2.0-bin` to the existing apt dependency
   list, retaining `libsecret-1-0` and Xvfb. No system or laptop settings change.
2. Wrap the qualification controller in
   `dbus-run-session -- xvfb-run -a bun <qualification-controller>`.
   The private session bus lasts for the controller and is terminated when it
   exits; this wrapper is explicitly intended for isolated regression tests.
   [D-Bus documentation](https://dbus.freedesktop.org/doc/dbus-run-session.1.html)
3. Inside that controller, create private runtime, keyring-data and control
   directories below `RUNNER_TEMP`. Spawn the owned daemon directly with
   `/usr/bin/gnome-keyring-daemon --foreground --components=secrets --unlock --control-directory=<owned-control>`.
   Set its child `XDG_DATA_HOME` to the owned keyring-data directory; discard
   inherited `GNOME_KEYRING_CONTROL`/PID values. Send a generated nonempty test
   password over stdin and close stdin. Do not use `--replace`, `--start` together
   with `--unlock`, an ambient keyring, SSH components or plaintext storage.
   `--unlock` creates/unlocks the login keyring from stdin; foreground mode keeps
   process ownership explicit. [GNOME source](https://gnome.pages.gitlab.gnome.org/gnome-keyring/coverage/daemon/gkd-main.c.gcov.html),
   [distribution manual](https://manpages.debian.org/unstable/gnome-keyring/gnome-keyring-daemon.1.en.html)
4. Bound readiness and verify the private bus owns `org.freedesktop.secrets`, for
   example through `gdbus call --session --dest org.freedesktop.DBus --object-path
/org/freedesktop/DBus --method org.freedesktop.DBus.GetNameOwner org.freedesktop.secrets`.
   This reads service ownership, not credentials. Keep the same bus, keyring and
   generated password across both app launches.
5. Pass that bus and owned runtime directory through the existing isolated
   qualification environment. Provide a fixed disposable GNOME desktop context
   (`XDG_CURRENT_DESKTOP=GNOME`) if required for backend detection; do not inherit
   arbitrary ambient desktop/provider settings. Verify the packaged app selects
   the real `gnome_libsecret` backend after readiness. An unavailable, `unknown`
   or `basic_text` result remains BLOCKED. This controlled keyring setup does not
   qualify a default desktop/compositor or physical display.
6. After confirmed app shutdown, terminate only the owned daemon, bound its exit,
   and let the private D-Bus wrapper exit. Capture only authored error codes and
   safe backend/process observations. Never upload daemon output or keyring files.

These are concrete integration steps, **not executed native evidence**. The initial
probe can be developed against unsigned candidate bytes without any provider
account or signing credential. Public qualification must run it again on every
exact public installer; candidate/helper evidence cannot be copied to public PASS.
