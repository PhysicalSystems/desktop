# Public installer build workflow

`.github/workflows/desktop-public-build.yml` implements public input preparation,
source validation, native Windows/Linux packaging and packaged simulation smoke.
It is restricted to an explicit dispatch of the owned repository's `main` branch
at that workflow's exact commit. There is no mutable source selector or unsigned
fallback. **The workflow deliberately fails at incomplete native qualification.**
It does not produce a publisher-eligible qualified distribution.

Do not dispatch this workflow until its signing setup has been provisioned and a
public build has been authorized. Adding the workflow does not provision accounts
or authorize signing, publishing, deployment or changes to an existing installation.

## Provisioning

Configure these repository variables without embedding credentials in their values:

- `DESKTOP_PUBLIC_BUILD_ENABLED=true` after the required accounts and secrets exist.
  It defaults to disabled when absent.
- `DESKTOP_WINDOWS_SIGNING_POLICY`: the explicit JSON `PublicSigningPolicy` from
  [public-build.ts](../packages/physicalsystems/src/release/public-build.ts).
  Choose the provisioned PFX publisher and uppercase certificate thumbprint, or
  the owned Azure publisher, endpoint, signing account and certificate profile.
  There is no example/default publisher that can silently become the release identity.

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
Linux jobs, source validation, input preparation and smoke receive no signing secrets.

No publication or website write credentials belong in this producer. Protect
reviewed `main` and restrict workflow dispatch to trusted repository operators;
that trusted source necessarily handles signing credentials during packaging.

## Implemented journey

1. Validate the owned main dispatch and enable variable, then freeze the explicit
   signing policy before dependency builds or access to signing credentials.
2. Read complete version history and prepare source-verified `ReleaseInputs`.
   Bind `PublicBuildInputs` to that source and release digest. Export both digests
   from the trusted prepare job; downstream jobs never calculate their expected
   anchors from a downloaded artifact.
3. Reuse `desktop-ci.yml` against that same immutable source.
4. Build Windows x64 NSIS and Linux x64 Debian/AppImage in parallel using
   `desktop-build-public.ts`. Packaging requires the compiled public identity
   marker and main-process hash, signs Windows under the frozen policy, and uses
   `--publish never`.
5. Exercise the exact packages in disposable hosted runners with device access
   disabled and the inert model fixture. Public smoke checks the embedded public
   identity and inputs, and observes actual Windows installer/payload signatures.
   Linux formats continue only after confirmed application and installation cleanup;
   an uncertain outcome stops further package access. No developer laptop or live
   hardware is involved in these probes.
6. Fail with `PUBLIC_NATIVE_QUALIFICATION_INCOMPLETE`. This is intentional even
   if the implemented smoke checks pass. No `qualified-distribution.json`,
   `desktop-public-qualified-*`, release tag or website selection is produced.

Input bundles, exact installers, unqualified build records and sanitized smoke
receipts have run/attempt-specific artifact names and 30-day retention. Uploads
use exact installer filenames and fixed metadata names; profiles, private logs,
credential files, runtime attachments and dependency caches are excluded.
`unqualified-public-desktop-build` says signing `NOT_VERIFIED` and qualification
`NOT_TESTED`. A separate `unqualified-public-desktop-smoke` receipt may contain
real signature observations and implemented smoke outcomes, but its overall result
remains `UNQUALIFIED` and each missing native check stays `NOT_TESTED`.

## Remaining release boundary

Public native qualification still needs real native credential storage, provider
browser sign-in, fresh installation, upgrades, failed-upgrade recovery,
uninstall/reinstall, configuration preservation and platform-display evidence.
The [strict evidence collector](public-collector.md) is implemented and validates
the exact bytes, signer and independently anchored native receipts. Complete native
receipt production and the final workflow handoff to that collector are not yet
implemented. Candidate fixture results cannot substitute for these checks.

Upgrade checks also require an approved previous **public-identity** baseline.
The first-public-release policy for that baseline is unresolved; the current
public validator has no `NOT_APPLICABLE` exception. Do not claim a candidate
installation is an equivalent public upgrade baseline or weaken the gate here.

After those checks and their trusted receipt producers are implemented, the
collector can produce the qualification bundle for the signed installers required
by [the public publisher](public-publisher.md).
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
