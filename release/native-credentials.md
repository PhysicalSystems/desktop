# Packaged native credential probe

The actual provider dialog uses the V2 integration API. Earlier candidate receipts
with `native-credential-probe` exercised the legacy `/auth` compatibility API;
those receipts do **not** prove that the current provider dialog stored secrets
with native encryption. The new `native-v2-credential-probe` must pass separately
on each exact packaged artifact. Its implementation and inert unit tests are not
evidence that a real provider account completed browser OAuth.

## Production credential boundary

[`Credential`](../packages/core/src/credential.ts) selects the authenticated native
vault whenever desktop mode or its native auth endpoint is configured. The actual
V2 routes are `POST /api/integration/:id/connect/key`, the integration OAuth
connect/complete routes, and `DELETE /api/credential/:id`. They use the same private
operator gateway and Electron `safeStorage` vault as legacy Auth. The renderer
receives sanitized connection IDs and labels, never a new secret-reading endpoint.

V2 records use a `physicalsystems.v2.<sha256(integrationID)>` vault namespace with
a versioned record wrapper preserving credential ID, integration ID, label and
value. Legacy Auth ignores these records and keeps its existing keys. Desktop
mode never falls back to plaintext SQLite; unavailable or malformed native storage
fails closed. Existing SQL records are preserved without automatic migration or
deletion. CLI use outside desktop mode retains its original SQL behavior.

An OAuth attempt becomes complete only after credential persistence acknowledges
success. A failed or expired attempt cannot become successful by resubmitting its
completion request. Cancellation before a queued native operation starts prevents
that operation. Once bounded native persistence starts, it and OAuth terminal
bookkeeping finish together; a disconnected HTTP request cannot report canceled
and then commit a credential later. A transport timeout remains unconfirmed, with
no automatic retry or destructive rollback of an uncertain write.

## Exact packaged integration

[`createNativeV2CredentialProbe`](../packages/physicalsystems/src/release/native-credentials-v2.ts)
provides observations only. Its tests use an explicitly reversible test cipher
and inert requests; they never launch Electron or a native keyring. Real packaged
qualification independently owns processes, native backend and installer hashes.

1. Use one fresh owned profile with hardware disabled. Select the bundled `openai`
   integration, overriding its API to the dedicated loopback fixture and compatible
   adapter. Configure no API key, authorization header or environment key. Keep
   the ordinary synthetic experiment provider separate. The qualifier fixes the
   database basename to `opencode.db` in its disposable profile only.
2. Adapt each request to the fresh owned sidecar attachment and exact Location.
   Require decoded successful GET envelopes with the exact directory, or HTTP 204
   for mutations. Do not log request bodies, credentials or attachment secrets.
3. `save(request)` confirms no existing connection, saves an inert canary through
   the actual V2 key route, and retains its sanitized credential ID. Native writes
   must acknowledge success within the bounded transport deadline.
4. `inspectFiles(profile, {databaseName: "opencode.db"})` checks the encrypted vault,
   absence of legacy `auth.json`, and complete bounded SQLite, WAL and rollback
   journal bytes for the canary in UTF-8 and UTF-16. It rejects symlinks, unexpected
   file ownership and unstable reads. No file contents or paths enter the receipt.
5. Confirm shutdown and cleanup, then relaunch the same artifact/profile as a fresh
   process. Select `openai/fixture` through the V2 session model route, admit the
   helper's fresh nonce prompt through the V2 prompt route, await its observed
   fixture request and session idle, then require the exact stored authorization
   header. This exercises the actual V2 model resolver after restart.
6. Remove only the same sanitized credential ID through the V2 credential route.
   Confirm shutdown and launch a third fresh process. `assertRemoved(request)`
   requires a successful disconnected integration response and a successful
   available-model catalog excluding that provider. An API failure is not evidence
   of absence. The native caller also requires no active session or new fixture
   request; it does not enqueue a prompt for an unavailable provider.
7. Require the observed native backend (`windows_dpapi` or controlled
   `gnome_libsecret`) and confirmed cleanup for all phases. Preserve existing
   simulation, restart and same-installer reinstall checks. Receipts contain fixed
   observations and hashes only; logs filter the private canary before storage.

The legacy helper remains available for compatibility regressions. Its old
unauthenticated-request removal observation does not apply to the V2 catalog,
which correctly makes a disconnected registered provider unavailable. Public
qualification must rerun these checks on each exact public installer; candidate
results are never copied into public qualification. Real-provider browser OAuth,
default desktop credentials, and user logout/login remain separately unverified.

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
