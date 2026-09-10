# Protected public desktop publication

**Release desktop (build, test, publish)** (`.github/workflows/desktop-public-release.yml`)
is the single public release workflow. Dispatch it once from reviewed `main`, select
the channel and Windows signing policy, and optionally supply a version. It runs:

```text
Freeze inputs → source checks → Windows / Linux builds and native tests
              → verify all results → prepare draft → approve release
              → publish exact installers → update and verify website
```

The [build and smoke stages](public-producer.md) run a strict collector that emits
a publisher bundle only after every required native observation passes. Its digest,
artifact ID and originating attempt flow directly through job outputs. No run ID,
attempt or digest needs to be copied into a second dispatch. The legacy separate
public build and website-promotion workflows have been removed. Source CI and the
reusable native packaging workflow remain internal building blocks. The candidate
workflow is for diagnostics and cannot publish.

The overall run is still executing at publication time. Preflight therefore checks
the owned main workflow identity and the successful collector job in its exact
originating attempt, rather than requiring a completed overall run. Forks, unrelated
runs, unsuccessful collectors and missing protected reviewers remain ineligible.

The publisher validates the producer identity and the existing `desktop-public-release` environment's required reviewers before accessing release credentials. It validates every installer and referenced receipt against the independently anchored qualification record, reserves a version in a draft release and uploads only missing exact assets. It streams every uploaded asset back and freezes the numeric release and asset IDs before waiting for one final protected approval.

After approval it downloads the same qualified bundle, verifies its bytes again, verifies the same draft and asset IDs, publishes that draft without rebuilding, then anonymously streams all three public downloads and checks their hashes. Only complete successful readback emits `public-review.json` and `desktop-selection.json`. The same approved job creates the one-file website selection PR, waits for its exact-head website checks, merges it automatically and verifies the live website selection. There is no release-preparation PR or additional human website approval in this path. Recovery uses the failed stage of this same workflow.

## Producer contract

Upload artifact `desktop-public-qualified-<run-id>-<attempt>` with a **flat**, allowlisted inventory:

- `qualified-distribution.json` matching the exported `QualifiedDistribution` type in `packages/physicalsystems/src/release/public-publisher.ts`.
- The three exact installer names from `candidateNames`: Windows x64 `.exe`, Linux x64 `.deb`, Linux x64 `.AppImage`.
- Every referenced sanitized JSON receipt named `<raw-file-sha256>.json`: the qualification bundle summary, Windows signature verification report and each installer qualification report. A repeated digest needs only one file.

The record is:

```json
{
  "schemaVersion": 1,
  "kind": "qualified-public-desktop-distribution",
  "facts": "PublicDistributionFacts object; see the exported TypeScript schema",
  "qualificationBundleSha256": "SHA-256 of the exact sanitized qualification bundle summary"
}
```

This illustration is not a valid qualification record. `facts` must be an object containing the exact public destination, version, channel, tag, immutable desktop source and release-input digests, public app identity, Windows signing evidence and all three installer inventories with their exact qualification receipt digests. It shares the existing strict public-distribution validator. Each existing native/authentication/install/recovery/display check must pass with evidence; skipped or unsupported checks cannot become `PASS`.

Verified Windows evidence retains `status: "verified"`, publisher, certificate thumbprint, installer and executable SHA-256 hashes, and verification-report SHA-256. Explicit unsigned previews use `status: "unsigned-preview"` with the same three hashes and no publisher/certificate fields. This exception requires a preview channel and `-beta.N` version, and the native observations described in the [collector contract](public-collector.md#explicit-unsigned-windows-preview-evidence). Stable releases require verified signing; removing signing configuration never creates an unsigned preview.

Unsigned release notes and the website selection carry the exact warning: **Unsigned Windows preview: Windows may warn or block installation.** New website selections use `schemaVersion: 2` and require `release.windowsSigning`: either `{ "status": "verified" }` or `{ "status": "unsigned-preview", "warning": "Unsigned Windows preview: Windows may warn or block installation." }`. Legacy schema-version-1 signed selections remain readable. A version-2 selection missing its signing status or unsigned warning is invalid. The website displays the warning before Windows downloads; Linux still offers both qualified formats.

The producer exports the **canonical** qualified-distribution digest (`publicReviewDigest(record)`) through its trusted job output and summary. The publisher must never derive its expected digest from the downloaded record itself. Receipt and binary digests use their raw bytes. The final website selection output digest also uses raw file bytes; the public review digest uses canonical JSON.

The producer must pin and test the public application identity. For signed distributions, sign the Windows installed executable and final installer **before** qualification; explicit unsigned previews must verify both files are unsigned. Do not rename, relabel, re-sign or rebuild after qualification. Sanitized receipts must retain source/artifact/signature bindings. The hash checker proves receipt identity, not its factual truth; the owned producer is responsible for actual checks and must remain protected as reviewed source.

## Infrastructure prerequisites

- Set `DESKTOP_PUBLIC_RELEASE_ENABLED=true` only after the real producer, qualification and explicitly selected Windows signing policy are ready.
- Precreate `desktop-public-release` with required reviewers. The workflow checks this and will not silently create an unprotected approval environment.
- `DESKTOP_DRAFT_TOKEN`: repository secret scoped to public download destination `PhysicalSystems/physicalsystems`, for draft preparation. GitHub does not offer a draft-only contents permission; protect reviewed workflow source and restrict who can dispatch it.
- `DESKTOP_RELEASE_TOKEN`: secret only in the protected publication environment, scoped to that same public release destination.
- `DESKTOP_WEBSITE_TOKEN`: secret in that same protected environment, scoped to `PhysicalSystems/platform` for the checked one-file PR and merge.
- The workflow must remain owned by `PhysicalSystems/desktop`. A fork, pull request run, different source, candidate workflow, unsuccessful collector or missing reviewer rule is rejected. Only an earlier successful collector in the same run can be reused for a publication retry.

No credentials, signing private keys, app profiles, camera imagery or raw runtime attachments belong in the bundle or repository. The publisher uploads only installers to GitHub Releases; its reviewed public metadata artifacts contain hashes and identities, not private qualification profiles.

## Recovery and limits

The destination is `PhysicalSystems/physicalsystems`, separate from the desktop source repository. The `desktop-v*` tag is anchored to the destination's immutable main commit recorded during reservation; the release body and public review identify the actual desktop source SHA.

Release reservation is keyed by version and canonical qualification digest. Every history page is read, visible drafts count, an existing independent tag blocks creation, and an unrelated draft body blocks reuse. Numeric release and asset IDs are frozen before approval. Changed IDs or bytes fail without deleting or overwriting assets. Existing incomplete published releases are not repaired automatically.

Lost create/upload/publish acknowledgements fail the current operation. If draft
preparation, publication, readback or website deployment fails, use **Re-run failed
jobs** (or rerun the failed job and its dependents) on that run. Successful
qualification and preparation outputs retain their immutable artifact IDs and
originating attempt. Preflight verifies the original successful collector via the
attempt-specific GitHub API. This resumes publication without rebuilding installers,
changing their version, replacing assets or copying identifiers into another workflow.

If publication succeeded, the same release is verified again; publication is not
replayed. A public readback failure emits no selection, preserving the previous
website selection. A website failure does not unpublish a verified release. The
protected publishing job still requires approval when rerun.

Do not choose **Re-run all jobs** to recover publication: that repeats version
allocation and builds. Likewise, a build/test failure before qualification should
start a fresh full run; partially rerunning native build stages can mix attempt-bound
inputs and is rejected. Artifacts must still be retained for publication recovery.

Qualified build artifacts expire after 30 days; publication review artifacts after 90 days. The published installers and release body remain durable, but long-term sanitized native/signature receipts still need an owned durable retention policy before relying on the release audit after artifact expiry.

Tests use synthetic byte payloads and fake GitHub responses. They verify ordering, digest and identity boundaries, uncertain-outcome recovery, nonreplacement and anonymous readback. They do not perform Authenticode signing, native login, actual installer lifecycle checks or a live GitHub publication. Headless UI blanking passed in prior application qualification; optical/display flicker was not measured.

## Public build identity and signing configuration

The [public build driver](public-build.md), `packages/desktop/physical-public.config.ts` and the pure `public-build.ts` helpers are implemented separately from the candidate packager. The [public producer workflow](public-producer.md) freezes inputs, reuses source checks, invokes native packaging and records actual public native observations. The driver scopes signing credentials to signed packaging. Its strict collector consumes independently anchored Windows/Linux job evidence and emits the qualified bundle only after every required check passes. Signed releases require real signing provisioning; every policy still requires complete native/account-backed qualification. Partial observations cannot produce a publishable bundle.

Public preview and stable use one fixed installation identity: `systems.physical.desktop`, product `Physical Systems`, package/executable `physical-systems-desktop`, and the default `physicalsystems-desktop` data directory. A preview-to-stable change must pass the same upgrade/configuration-preservation checks. Candidate/development identity and default data remain unchanged. This policy does not automatically migrate existing candidate data.

Before compiling, a producer must create a separate `PublicBuildInputs` record containing the exact source SHA, already-verified release input digest, version/channel, fixed public identity and an explicit signing policy. Both the public record digest and underlying release input digest are independently supplied to the builder. `PHYSICALSYSTEMS_PUBLIC_BUILD_INPUTS` is an absolute runner-private file path; `PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256` and `PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256` are trusted upstream job outputs. Setting an application launch-time environment variable cannot relabel a packaged candidate. Electron-vite embeds the identity in the main process and writes a compilation receipt bound to the main output hash. The public packager requires that receipt and rejects candidate output or changed compiled main bytes.

The build uses publication disabled and the producer invokes packaging with `--publish never`. Public installations allow operator-requested local or SSH Node attachment. Packaged candidates keep device connections disabled, and `PHYSICALSYSTEMS_ALLOW_DEVICES=0` always disables them, including in public installations. All automated build and native qualification environments set that disabling value. Enabling attachment does not start a camera capture, configure a robot, or grant execution approval. Public Linux uses the owned `AppRun.public` launcher and never disables Chromium sandboxing.

Signed Windows configuration enables executable signing, requires code signing and retains update signature verification. Signing policy is explicitly one of:

- `pfx`: pin publisher and expected certificate thumbprint. Supply the private PFX at `PHYSICALSYSTEMS_PFX_FILE` and its password through electron-builder's `WIN_CSC_KEY_PASSWORD`, outside the input record. Passwords are not serialized into packaging configuration. The producer must still verify the actual executable and installer signer/thumbprint after signing.
- `azure-trusted-signing`: pin publisher, Azure signing endpoint, account and certificate profile. The current adapter requires an explicitly provisioned Azure service identity (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`); federated/OIDC credentials need separate integration. Credentials never enter the public input record or configuration.
- `unsigned-preview`: an explicit preview-beta-only policy with no publisher, certificate or signing credentials. Both executable and installer must actually be unsigned, and the resulting publication retains the warning above. All existing native and approval requirements remain in place.

Missing credentials for a signed policy, absent signing policy or an unsupported mode fail before a Windows public package can be produced. Linux construction does not require Windows private credentials. These unit/configuration checks do not exercise a real PFX, Azure signing service, native provider login or Windows certificate verification. No signing account has been selected or provisioned by this implementation.
