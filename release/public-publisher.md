# Protected public desktop publication

`desktop-public-release.yml` adds the publication half of the release process. It consumes signed, publicly identified, natively qualified installers from the owned producer. It does **not** make today's unsigned internal candidates publicly eligible, implement signing, or claim that native checks have passed.

The producer prerequisite is `.github/workflows/desktop-public-build.yml`, successful on the exact reviewed `main` commit used by the publisher. Its [implemented build and smoke stages](public-producer.md) currently fail deliberately at incomplete native qualification and emit only unqualified artifacts. The existing `.github/workflows/desktop-release.yml` is deliberately rejected. Until complete native evidence and credentials exist, preflight fails closed. Do not change candidate or unqualified booleans to `PASS`.

One dispatch to **Publish qualified desktop installers** supplies the producer run ID, its exact current attempt and the canonical qualified-distribution digest from the trusted producer summary. This is a continuation of a previously qualified build; it is not yet a one-dispatch build-and-publish pipeline. A future top-level coordinator can combine those phases without rebuilding qualified bytes.

The publisher validates the producer identity and the existing `desktop-public-release` environment's required reviewers before accessing release credentials. It validates every installer and referenced receipt against the independently anchored qualification record, reserves a version in a draft release and uploads only missing exact assets. It streams every uploaded asset back and freezes the numeric release and asset IDs before waiting for one final protected approval.

After approval it downloads the same qualified bundle, verifies its bytes again, verifies the same draft and asset IDs, publishes that draft without rebuilding, then anonymously streams all three public downloads and checks their hashes. Only complete successful readback emits `public-review.json` and `desktop-selection.json`. The same approved job creates the one-file website selection PR, waits for its exact-head website checks, merges it automatically and verifies the live website selection. There is no release-preparation PR or additional human website approval in this path. The separate promotion workflow is a recovery path.

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

This illustration is not a valid qualification record. `facts` must be an object containing the exact public destination, version, channel, tag, immutable desktop source and release-input digests, public app identity, verified Windows publisher/certificate/installer/executable evidence and all three installer inventories with their exact qualification receipt digests. It shares the existing strict public-distribution validator. Each existing native/authentication/install/recovery/display check must pass with evidence; skipped or unsupported checks cannot become `PASS`.

The producer exports the **canonical** qualified-distribution digest (`publicReviewDigest(record)`) through its trusted job output and summary. The publisher must never derive its expected digest from the downloaded record itself. Receipt and binary digests use their raw bytes. The final website selection output digest also uses raw file bytes; the public review digest uses canonical JSON.

The producer must pin and test the public application identity before signing. Sign the Windows installed executable and final installer **before** qualification. Do not rename, relabel, re-sign or rebuild after qualification. Sanitized receipts must retain source/artifact/signature bindings. The hash checker proves receipt identity, not its factual truth; the owned producer is responsible for actual checks and must remain protected as reviewed source.

## Infrastructure prerequisites

- Set `DESKTOP_PUBLIC_RELEASE_ENABLED=true` only after the real producer, qualification and signing setup exist.
- Precreate `desktop-public-release` with required reviewers. The workflow checks this and will not silently create an unprotected approval environment.
- `DESKTOP_DRAFT_TOKEN`: repository secret scoped to public download destination `PhysicalSystems/physicalsystems`, for draft preparation. GitHub does not offer a draft-only contents permission; protect reviewed workflow source and restrict who can dispatch it.
- `DESKTOP_RELEASE_TOKEN`: secret only in the protected publication environment, scoped to that same public release destination.
- `DESKTOP_WEBSITE_TOKEN`: secret in that same protected environment, scoped to `PhysicalSystems/platform` for the checked one-file PR and merge.
- Both source and artifact workflows must remain owned by `PhysicalSystems/desktop`. A fork, pull request run, failed run, stale attempt, different source, candidate workflow or missing reviewer rule is rejected.

No credentials, signing private keys, app profiles, camera imagery or raw runtime attachments belong in the bundle or repository. The publisher uploads only installers to GitHub Releases; its reviewed public metadata artifacts contain hashes and identities, not private qualification profiles.

## Recovery and limits

The destination is `PhysicalSystems/physicalsystems`, separate from the desktop source repository. The `desktop-v*` tag is anchored to the destination's immutable main commit recorded during reservation; the release body and public review identify the actual desktop source SHA.

Release reservation is keyed by version and canonical qualification digest. Every history page is read, visible drafts count, an existing independent tag blocks creation, and an unrelated draft body blocks reuse. Numeric release and asset IDs are frozen before approval. Changed IDs or bytes fail without deleting or overwriting assets. Existing incomplete published releases are not repaired automatically.

Lost create/upload/publish acknowledgements fail the current operation. Rerun the full publisher with the same inputs to reconcile the durable release ID and exact completed assets. If publication succeeded but readback or website deployment failed, the same release is verified again; publication is not replayed and no binary is replaced. Re-run **all jobs**, because preparation artifacts include the workflow attempt in their name. A public readback failure emits no selection, preserving the website's previously selected release. A website failure does not unpublish a verified release.

Workflow evidence expires after 90 days. The published installers and release body remain durable, but long-term sanitized native/signature receipts still need an owned durable retention policy before relying on the release audit after artifact expiry.

Tests use synthetic byte payloads and fake GitHub responses. They verify ordering, digest and identity boundaries, uncertain-outcome recovery, nonreplacement and anonymous readback. They do not perform Authenticode signing, native login, actual installer lifecycle checks or a live GitHub publication. Headless UI blanking passed in prior application qualification; optical/display flicker was not measured.

## Public build identity and signing configuration

The [public build driver](public-build.md), `packages/desktop/physical-public.config.ts` and the pure `public-build.ts` helpers are implemented separately from the candidate packager. The [public producer workflow](public-producer.md) freezes inputs, reuses source checks, invokes native packaging and records public smoke evidence. The driver scopes signing credentials to packaging. Output remains unqualified: real signing provisioning, remaining native checks and qualified-bundle production are **not yet completed or qualified**.

Public preview and stable use one fixed installation identity: `systems.physical.desktop`, product `Physical Systems`, package/executable `physical-systems-desktop`, and the default `physicalsystems-desktop` data directory. A preview-to-stable change must pass the same upgrade/configuration-preservation checks. Candidate/development identity and default data remain unchanged. This policy does not automatically migrate existing candidate data.

Before compiling, a producer must create a separate `PublicBuildInputs` record containing the exact source SHA, already-verified release input digest, version/channel, fixed public identity and an explicit signing policy. Both the public record digest and underlying release input digest are independently supplied to the builder. `PHYSICALSYSTEMS_PUBLIC_BUILD_INPUTS` is an absolute runner-private file path; `PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256` and `PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256` are trusted upstream job outputs. Setting an application launch-time environment variable cannot relabel a packaged candidate. Electron-vite embeds the identity in the main process and writes a compilation receipt bound to the main output hash. The public packager requires that receipt and rejects candidate output or changed compiled main bytes.

The build uses publication disabled and the producer invokes packaging with `--publish never`. All packaged modes preserve the existing `PHYSICALSYSTEMS_ALLOW_DEVICES=0` boundary. Public Linux uses the owned `AppRun.public` launcher and never disables Chromium sandboxing.

Windows configuration enables executable signing, requires code signing and retains update signature verification. Signing policy is explicitly either:

- `pfx`: pin publisher and expected certificate thumbprint. Supply the private PFX at `PHYSICALSYSTEMS_PFX_FILE` and its password through electron-builder's `WIN_CSC_KEY_PASSWORD`, outside the input record. Passwords are not serialized into packaging configuration. The producer must still verify the actual executable and installer signer/thumbprint after signing.
- `azure-trusted-signing`: pin publisher, Azure signing endpoint, account and certificate profile. The current adapter requires an explicitly provisioned Azure service identity (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`); federated/OIDC credentials need separate integration. Credentials never enter the public input record or configuration.

Missing credentials or an unsupported signing mode fail before a Windows public package can be produced. Linux construction does not require Windows private credentials. These unit/configuration checks do not exercise a real PFX, Azure signing service, native provider login or Windows certificate verification. No signing account has been selected or provisioned by this implementation.
