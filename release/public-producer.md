# Public installer build workflow

`.github/workflows/desktop-public-build.yml` implements public input preparation,
source validation, native Windows/Linux packaging and packaged simulation smoke.
It is restricted to an explicit dispatch of the owned repository's `main` branch
at that workflow's exact commit. The explicit `windows_signing` choice defaults to
`signed`; `unsigned-preview` is accepted only with `channel=preview`. There is no
automatic fallback after missing credentials or failed signing. Its final job runs
the strict collector: a publisher-eligible bundle is
created only when every required native check passes for every exact artifact.
Missing observations fail collection; there is no unconditional terminal stub.

Dispatch requires an authorized public build and provisioning for its selected
policy. Adding the workflow does not provision accounts
or authorize signing, publishing, deployment or changes to an existing installation.

## Provisioning

Configure these repository variables without embedding credentials in their values:

- `DESKTOP_PUBLIC_BUILD_ENABLED=true` after the selected policy is ready.
  It defaults to disabled when absent.
- For `windows_signing=signed`, `DESKTOP_WINDOWS_SIGNING_POLICY`: the explicit JSON `PublicSigningPolicy` from
  [public-build.ts](../packages/physicalsystems/src/release/public-build.ts).
  Choose the provisioned PFX publisher and uppercase certificate thumbprint, or
  the owned Azure publisher, endpoint, signing account and certificate profile.
  There is no example/default publisher that can silently become the release identity.

For `windows_signing=unsigned-preview`, preparation freezes exactly
`{"provider":"unsigned-preview"}`. It needs no signing policy variable, PFX, Azure
account, publisher name or certificate identity. The Windows job receives empty
signing-secret values and runs a separate step without signing credentials. The
driver rechecks that the selected workflow branch matches the immutable policy,
scrubs signing credentials and disables certificate discovery. Packaging sets
`forceCodeSigning=false` and `signExecutable=false`; icon/version editing and the
future signed-update verification setting stay enabled. Stable rejects this policy
both at preflight and at immutable input validation.

Unsigned PREVIEW users may see Windows SmartScreen warnings and an unknown
publisher. Download and review the published checksums before running an installer.
The public download record reports `unsigned-preview`, with no invented publisher
or certificate identity. This is a deliberately unsigned prerelease, not a signature
verification success.

Configure `DESKTOP_RELEASE_HISTORY_TOKEN` with **read-only contents access** to
`PhysicalSystems/physicalsystems`. The desktop repository's ordinary GitHub token
cannot read draft releases in that separate repository. Preparation needs complete
history including drafts and prereleases; it must not label anonymous/public-only
history complete. This credential is available only to the history-read step.
The publisher separately rechecks version reservation before creating any release.

For PFX signing, configure repository secrets `DESKTOP_WINDOWS_PFX_BASE64` and
`DESKTOP_WINDOWS_PFX_PASSWORD`. The first contains canonical base64 for a PFX of
at most one MiB. The Windows build step creates a private, exclusive temporary
file and removes it in `finally`, including after packaging failure. The file
path, PFX bytes and password never enter input records or artifact uploads.

For Azure Trusted Signing, configure `DESKTOP_AZURE_TENANT_ID`,
`DESKTOP_AZURE_CLIENT_ID` and `DESKTOP_AZURE_CLIENT_SECRET`. Federated/OIDC signing
is not implemented. Only the selected signing provider's credentials are passed
to the build driver, and the driver passes them only to its final packaging
subprocess. Dependency installation and compilation receive scrubbed environments.
Linux jobs, unsigned PREVIEW packaging, source validation, input preparation and
smoke receive no signing secrets.

No publication or website write credentials belong in this producer. Protect
reviewed `main` and restrict workflow dispatch to trusted repository operators;
that trusted source handles signing credentials only when signed packaging is selected.

## Implemented journey

1. Validate the owned main dispatch and enable variable, then freeze the explicit
   signing policy before dependency builds or access to signing credentials.
2. Read complete version history and freeze separate source-verified input pairs
   for a strictly lower unreleased lab baseline and the target. Export all four
   release/public digests and the exact upgrade-plan digest from the trusted
   prepare job; downstream jobs never self-anchor downloaded input files.
3. Reuse `desktop-ci.yml` against that same immutable source.
4. Build Windows x64 NSIS and Linux x64 Debian/AppImage in parallel using
   `desktop-build-public.ts`. Packaging requires the compiled public identity
   marker and main-process hash, applies the frozen Windows signing policy, and uses
   `--publish never`. Each native job builds the separately versioned lab with
   the same policy; its installers never enter the target inventory.
5. Exercise the exact packages in disposable hosted runners with device access
   disabled and the inert model fixture. Public smoke checks the embedded public
   identity and inputs, and observes actual Windows installer/payload signatures.
   Unsigned PREVIEW requires both files to report `NotSigned` with no signer
   certificate; it records `UNSIGNED_PREVIEW` and the `public-unsigned-preview`
   check, never a `public-signing` pass. Signed mode still requires both valid,
   policy-matching signatures. Upgrade and recovery validate the same policy on
   both the lower-version lab and the target before mutating an installation.
   Linux formats continue only after confirmed application and installation cleanup;
   an uncertain outcome stops further package access. No developer laptop or live
   hardware is involved in these probes.
6. Author sanitized native receipts from fixed in-process probe IDs. A separate
   Windows job and Linux job each export a raw SHA-256 for `native-job.json`, plus
   the immutable IDs of their installer and receipt uploads. The jobs call
   `desktop-public-package.yml`; no matrix output can overwrite another platform's
   evidence anchor.
7. Download those exact artifact IDs, verify each native-job file against its
   separately trusted output digest, and build the existing `PublicCollectionPlan`
   only from those verified bindings. Copy only the named installers and receipts
   into a new flat evidence directory, rechecking copied hashes.
8. Invoke the strict collector. Complete evidence produces
   `desktop-public-qualified-<run-id>-<attempt>` and an independently exported
   `qualification_sha256`; incomplete evidence produces no qualified bundle and
   fails the producer. Neither outcome signs another artifact or publishes a release.

Input bundles, exact installers, unqualified build records and sanitized smoke
receipts have run/attempt-specific artifact names and 30-day retention. Uploads
use exact installer filenames and fixed metadata names; profiles, private logs,
credential files, runtime attachments and dependency caches are excluded.
`unqualified-public-desktop-build` says signing `NOT_VERIFIED` and qualification
`NOT_TESTED`. A separate `unqualified-public-desktop-smoke` receipt may contain
real signature observations and implemented smoke outcomes, but its overall result
remains `UNQUALIFIED`. A separate `public-desktop-native-qualification` receipt
records all eight required native statuses, including `NOT_TESTED` for missing
probes. The smoke step can finish successfully while these statuses remain
untested, allowing both platforms' observations to be gathered; the final strict
collector still fails until they are complete.

## Fixed native observation contract

`public-native-receipts.ts` maps the reviewed smoke controller's observations:

| Public requirement         | Actual observation required                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Native credential storage  | `native-v2-credential-probe`; the legacy `/auth` canary alone is insufficient                                                     |
| Provider browser sign-in   | `native-provider-browser-probe`                                                                                                   |
| Fresh install              | NSIS/Debian package installation and actual launch/isolation/setup checks; AppImage needs `native-fresh-appimage-probe`           |
| Upgrade                    | `native-upgrade-probe`                                                                                                            |
| Failed-upgrade recovery    | `native-failed-upgrade-recovery-probe`                                                                                            |
| Uninstall/reinstall        | `native-reinstall-probe` and package/launcher cleanup                                                                             |
| Configuration preservation | The same reinstall probe preserves the original session, transcript, completed trials and deliberately changed pinch-zoom setting |
| Platform display           | `native-platform-display-probe`, within its explicitly tested display environment                                                 |

These mappings also require confirmed application/private-service cleanup, and
Windows requires the actual observation matching its declared signing policy.
Missing probes stay `NOT_TESTED`; failed or
blocked dependencies retain that result. AppImage smoke exercises the original
extract-and-run runtime and portable replacement within its documented Ubuntu
AppArmor prerequisite. Configuration preservation
does not claim every possible user file or a default-profile migration. Display
evidence must not claim Wayland or optical flicker from an X11/hosted test.

Additional probes are authored in the actual native smoke process. There is no
manual JSON upload, environment boolean or input flag that grants PASS. A native
receipt and its job manifest contain fixed IDs/statuses and immutable bindings;
profiles, provider values, arbitrary diagnostic strings and logs remain excluded.

## Remaining release boundary

Public native qualification still needs the actual complete observations above
on the exact public artifacts under their declared signing policy. Candidate native
evidence cannot substitute for them.
The [strict evidence collector](public-collector.md) is implemented and validates
the exact bytes, declared signature state and independently anchored native receipts. Native receipt
production and workflow handoff are implemented; no helper test establishes that
the missing operating-system or account-backed probes have actually passed.

Upgrade and recovery use a separately frozen lower-version **public-identity lab
baseline**, described in [public-upgrade.md](public-upgrade.md). Its actual native
controllers are implemented for NSIS, Debian and portable AppImage. The fixture
shares reviewed source/storage schema and is never published; it bootstraps the
first release without pretending to test historical migrations. All native gates
remain mandatory and require actual successful public runs.

After the actual checks pass, the wired collector produces the qualification
bundle for signed installers or explicitly unsigned PREVIEW installers accepted by
[the public publisher](public-publisher.md). Stable still requires signed Windows bytes.
That publisher currently requires a separate dispatch, verifies its producer
run/source identity, completes an exact-byte draft, obtains one final protected
approval and updates the website after public readback. Automatic producer-to-
publisher coordination remains a follow-up; no additional human release-preparation
or website PR approval should be added.

The tests for this workflow's helpers use synthetic signing material and faked
build operations only. They verify isolation and failure behavior, not a real
signing account, provider login, operating-system upgrade or physical display.
Headless UI blanking passed in earlier controlled testing; optical/display flicker
was not measured.
