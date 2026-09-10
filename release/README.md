# Physical Systems Desktop candidates

This pipeline prepares **internal, unsigned desktop candidates**. It has no publication, tag creation, package publishing, website mutation, signing credentials or update-enabling step. Its GitHub token has `contents: read`. A successful candidate run is evidence for review; it is not authorization or qualification for a public release.

The desktop has its own version sequence, initially `0.1.0-beta.1`. It bundles the pinned OpenCode agent server and public Physical Systems operator artifact. Desktop candidate preparation does not rebuild, discover, install or upgrade a hardware-host Physical Systems Node. The existing npm and private Node release processes remain separate.

## Fork workflow ownership

The inherited OpenCode workflows retain their original conditions and also require `github.repository == 'anomalyco/opencode'` on every job. This prevents upstream maintenance bots, tests and publishing jobs from running in the Physical Systems fork, including jobs using `always()`. The owned `desktop-*.yml` workflows provide source checks, internal candidate preparation, protected public publication and an explicit website recovery path. Preserve these guards when updating from upstream; review newly added upstream jobs before enabling them.

## Maintainer workflow

1. Commit and review the desktop source, including the vendor manifest and release policy. Source and bundled artifacts must be clean and their hashes must match. Make this commit available in the desktop repository before requesting a CI candidate.
2. Dispatch **Prepare desktop candidate (no publication)** with its full lowercase commit SHA. The default track is `preview`; an empty version allocates the next preview from the public download repository's fully paginated visible `desktop-v*` release history. `stable` requires an explicit version and still produces only an internal candidate.
3. The prepare job reads every page of this repository's releases, including prereleases and any drafts visible to its read credential, and creates one immutable input bundle. Unrelated upstream release tags are excluded. A failed or incomplete history read cannot be treated as an empty history. A source-repository token may not see drafts in the separate public destination; candidate allocation remains provisional and the protected public publisher must check all draft/tag reservations with the appropriate credential.
4. Required source checks run against that exact SHA. The Windows x64 and Linux x64 package jobs then run in parallel, consuming the same inputs and tracked model catalog. Packaging always uses `--publish never` and the Physical Systems candidate configuration.
5. Each platform qualifies the exact generated files, then verifies artifact hashes against the sanitized qualification receipts. No replacement build occurs after qualification. Download the candidate assessment and per-platform reports before using the installer artifacts for internal review.

The dispatch is serialized to avoid concurrent version allocation. Because this workflow does not reserve tags or create draft releases, an unpublished version remains provisional and may recur in a later candidate run. Run ID, attempt, source SHA and artifact digest identify a candidate. The protected publisher independently rechecks version and tag availability before publication; never relabel an existing binary as a new version.

All jobs check out a fixed SHA. Download caches are keyed by OS, architecture, Node/Bun pins and the lockfile. They contain package, Electron and packaging-tool downloads; they do not contain installed-app profiles, native outputs shared between platforms, credentials or test evidence. Dependencies install with `--frozen-lockfile --ignore-scripts`; the allowlisted preparation step downloads the locked Electron binary explicitly. The workflow does not invoke upstream desktop prebuild or publishing hooks.

Dependency and Electron download caches are saved immediately after successful
setup, so a later packaged-app test failure does not discard that completed work.
Packaging-tool downloads use a separate cache saved after successful packaging,
before native qualification; public builds require both target and lab baseline
packaging to succeed. A later display-setup or native-test failure therefore does
not discard verified tooling. Failed packaging does not save the cache. Installed
dependencies and application outputs are rebuilt; neither cache substitutes for
qualification.

## Files and commands

| File                                               | Responsibility                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `release/desktop.json`                             | Desktop version/channel policy, toolchain and compatibility declarations                            |
| `release/models.dev-api.json.gz`                   | Reviewed model-catalog snapshot; both its compressed and decoded bytes are pinned                   |
| `packages/physicalsystems/vendor/manifest.json`    | Canonical operator source revision, source hashes and bundled artifact hashes                       |
| `script/desktop-release.ts`                        | Candidate preparation, input verification, builds, qualification, artifact verification and summary |
| `packages/desktop/physical-release.config.ts`      | Candidate NSIS, `.deb` and AppImage packaging with publication disabled                             |
| `.github/actions/setup-desktop-build/action.yml`   | Pinned tools and narrowly scoped dependency preparation                                             |
| `.github/workflows/desktop-ci.yml`                 | Package-local regression tests and integration, app, desktop and agent-server typechecks            |
| `.github/workflows/desktop-release.yml`            | Manual, immutable-source candidate orchestration                                                    |
| `packages/physicalsystems/test/packaged-smoke.mjs` | Isolated qualification of each actual package format                                                |

The [actual provider browser review](provider-browser-review.md) describes the
opt-in encrypted device-login operation and native account fingerprint checks.

The CLI supports the following sequence on disposable CI runners. Use absolute output paths **outside the checkout** and run it from a clean, committed source tree. Full packaged qualification requires `CI=true`; do not set that flag on the robot laptop to bypass the environment restriction. `history.json` must contain `{ "complete": true, "versions": [...] }` obtained from a successful complete history read; do not manufacture an empty history for an existing release repository.

```sh
bun script/desktop-release.ts prepare \
  --source-sha "$DESKTOP_SOURCE_SHA" --repository "$DESKTOP_REPOSITORY" \
  --channel preview --history "$DESKTOP_WORK/history.json" \
  --output "$DESKTOP_WORK/inputs"

bun script/desktop-release.ts verify-inputs \
  --inputs "$DESKTOP_WORK/inputs/release-inputs.json"

bun script/desktop-release.ts build \
  --inputs "$DESKTOP_WORK/inputs/release-inputs.json" \
  --platform linux-x64 --output "$DESKTOP_WORK/artifacts"

xvfb-run -a bun script/desktop-release.ts qualify \
  --inputs "$DESKTOP_WORK/inputs/release-inputs.json" \
  --artifacts "$DESKTOP_WORK/artifacts" --output "$DESKTOP_WORK/receipts"

bun script/desktop-release.ts verify-artifacts \
  --inputs "$DESKTOP_WORK/inputs/release-inputs.json" \
  --artifacts "$DESKTOP_WORK/artifacts" --receipts "$DESKTOP_WORK/receipts" \
  --output "$DESKTOP_WORK/reports"
```

For Windows, use `--platform windows-x64` on a disposable Windows runner and omit `xvfb-run`. The NSIS install smoke is CI-only and targets a fresh temporary directory. It must not be redirected to an existing installation. Linux qualification installs the `.deb` with its shipped AppArmor policy on an owned GitHub-hosted runner and removes it only after confirmed shutdown. The AppImage check executes the original artifact with `--appimage-extract-and-run`, after loading an exact-path temporary AppArmor profile for the runtime's extraction location. This advanced mode requires the documented Ubuntu prerequisite; it does not establish stock Ubuntu double-click or FUSE behavior. The website prefers the `.deb` on Linux. Neither path disables Chromium's sandbox. See [AppImage runtime and replacement](appimage-runtime.md) for the exact scope and ownership checks.

The source checks use `bun test` and `bun typecheck` from the affected package directories. Root-level `bun test` is intentionally unsupported in this monorepo. Upstream publishing scripts and the canonical `check:release-packages` command are not part of this desktop workflow.

## Inputs, artifacts and evidence

The input bundle contains `release-inputs.json`, `history.json`, the decoded `models.dev-api.json`, and `SHA256SUMS`. The record fixes the desktop version/channel, repository and source commit, OpenCode baseline, canonical operator revision/digests, lockfile, toolchain, model catalog and compatibility declarations. Both platforms verify these bytes before building. A platform does not refresh its model catalog independently or rebuild the operator from a developer-local checkout.

In GitHub Actions, every consuming CLI command also requires `PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256` and `PHYSICALSYSTEMS_RELEASE_REPOSITORY`. The expected digest comes from the trusted prepare job's output, and the repository comes from the workflow context. They must not be derived from the downloaded record being checked: a self-consistent replacement record is insufficient. Local diagnostics still verify the record against source and may supply the same anchors explicitly.

| Target                        | Files prepared   | Automated qualification boundary                                                                           |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Windows x64 on `windows-2025` | NSIS `.exe`      | Fresh temporary installation and packaged simulation checks; no signing or real provider credentials       |
| Linux x64 on `ubuntu-24.04`   | `.deb`, AppImage | Owned Debian install/uninstall and original AppImage extract-and-run with scoped sandbox setup, under Xvfb |

Each platform retains the exact installer files, `artifacts.json`, `SHA256SUMS`, per-artifact qualification JSON and a verification report. Failure paths retain available sanitized receipts and `workflow-status.json`; a skipped or missing required check cannot become a pass. The final assessment collects both platform reports and retains `summary.json`, `summary.md`, checksums and `candidate-downloads.json`.

`candidate-downloads.json` is review metadata: publication is disabled and download URLs are unset. It is not the public website's selected-release manifest. Artifacts use run/attempt-specific names and 30-day retention. Preserve a reviewed, sanitized evidence bundle in the eventual durable release record before relying on it beyond that retention period.

Temporary app profiles, credentials, runtime attachment files, browser logs and screenshots are excluded from workflow uploads. Qualification uses a local inert provider and synthetic experiments, with hardware access disabled. Those results do not verify real provider authentication, cameras or robot behavior. Headless UI blanking checks do not measure optical/display flicker.

For a failing candidate, the optional `diagnostic_public_key` dispatch input accepts an RSA public PEM of at least 3072 bits. Generate and retain its private key outside the repository; never submit a private key to GitHub. The qualifier can encrypt bounded tails of only its own `application.log` and `diagnostic.txt`, authenticating the run, attempt, source and artifact digest. Only ciphertext leaves the runner, in a separate three-day diagnostic artifact; profiles, attachments and imagery are never included. Missing or invalid diagnostic inputs cannot make qualification pass. This envelope is troubleshooting data, not qualification or publication evidence.

## Public release blockers and follow-up

The candidate identity is deliberately `Physical Systems Candidate`, using the development application identity. Public preview and stable builds use the fixed `systems.physical.desktop` identity, `Physical Systems` product name and `physicalsystems-desktop` profile directory. The separate public build configuration pins this at compilation; candidate output cannot be relabeled by packaging it again. Profile migration and installation lifecycle still require native qualification.

Public release remains blocked until the applicable evidence and infrastructure exist:

- Run and review the new CI workflow on both target platforms. Local unit or configuration validation does not substitute for Windows installer execution.
- Provider account sign-in is optional for a preview: use `provider_qa=disabled`. The release records `NOT_TESTED` and discloses that sign-in was not verified. Stable still requires provider sign-in to pass; failed checks and incomplete installer cleanup continue to block publication.
- Select the public Windows policy explicitly. Signed releases require a provisioned signing identity and verification of both executable and installer. An unsigned Windows preview requires `channel=preview` and `windows_signing=unsigned-preview`, native proof that both files are unsigned, and the download warning. Stable still requires signing. Internal candidate receipts cannot qualify either public mode.
- Qualify provider browser opening and native credential storage on supported OS profiles. Fixture-provider tests and fake encryption are separate evidence.
- Qualify actual supported OS versions, Linux installation/launcher behavior, X11/Xwayland and Wayland display behavior, plus clean-machine operation without developer Node/Bun in the installed application's runtime path.
- Exercise fresh installation, upgrade from a previously qualified desktop, failed/interrupted upgrade recovery, uninstall/reinstall, preserved history/configuration and unresolved operation ownership in disposable environments.
- Verify the declared desktop/operator/Node compatibility and canonical operator source/provenance. Declared or unverified compatibility must not be advertised as tested hardware support.
- Run the implemented public build/native-qualification producer with the selected policy and provision the release credentials. The publisher consumes its independently anchored evidence and publishes exact bytes without rebuilding; it cannot qualify or promote an internal candidate.

The first public preview should retain manual updates until installation lifecycle checks pass. Any later in-app updater must use owned feeds, verify the expected publisher, prohibit automatic downgrade, and respect confirmed shutdown/operation ownership. A desktop update must never silently restart a hardware session or upgrade its Node service. This candidate workflow neither enables nor qualifies in-app updates.

## Website download integration

The public installer destination is **PhysicalSystems/physicalsystems**, matching the existing `PhysicalSystems/platform` download page. Desktop source may live in its separate fork. The existing npm and Node releases remain independent; the website looks up the selected exact `desktop-v${version}` tag, so newer npm releases cannot displace a desktop download.

The website integration is reviewed in [platform PR #287](https://github.com/PhysicalSystems/platform/pull/287). Its controlled `public/desktop-selection.json` starts with `release: null`. The page offers only installers matching that selection and live GitHub metadata, with bounded requests and explicit recovery. It does not claim to check binary bytes or Windows signatures inside the browser. A successful empty selection withdraws downloads.

The [public producer workflow](public-producer.md) freezes the explicit Windows signing policy and exact source inputs, reuses source CI, invokes the [public build driver](public-build.md) for Windows/Linux and records actual public-mode native observations. Signing credentials are scoped to packaging. Separate Windows/Linux job outputs anchor the exact bytes and receipts for the strict collector, which emits a qualified bundle only when all required checks pass. Signing setup is required only for the signed policy. Native checks and account sign-in remain prerequisites for both public modes; partial observations stay unqualified.

Dispatch **Release desktop (build, test, publish)** once from main. The [single public workflow](public-publisher.md) builds and tests both platforms, then continues automatically through publication and the website update:

1. Consume the successful qualification stage of this run on the exact reviewed source, using signed Windows installers or an explicitly qualified unsigned preview. Verify the anchored bundle, reserve a draft and upload the exact installers.
2. Obtain **one final protected approval**, then publish without rebuilding or replacing assets.
3. Anonymously stream the published files and verify their sizes and SHA-256 hashes. Only successful readback produces the website selection.
4. In that same approved job, create or resume a one-file website integration PR. Website CI validates the selection contract and independently reads the public bytes. Selection-only changes do not repeat dependency installation and the full application build.
5. The coordinator verifies successful CI for the exact PR, head, base and current attempt, rechecks scope and selection bytes, and merges through the normal GitHub API. Repository rules remain effective; the coordinator does not use an administrator override.
6. Confirm Render serves the exact selection, a healthy API and the download page. An uncertain update can be resumed without replacing installers or duplicating the PR. A failed deployment is not reported as complete.

There is no second workflow dispatch, release-preparation PR or second human website approval. The old standalone public build and website-promotion workflows have been removed. If publication or the website update fails, use **Re-run failed jobs** in the same release run to reuse its exact qualified installers. See the publisher guide for credentials, immutable evidence and retry prerequisites.

A JSON field saying approved is insufficient: `PublicDistributionReview` must come from the protected process, with an independently anchored canonical digest. The public build producer and required native qualification are still prerequisites; adding the workflow or setting an enable variable does not satisfy them.

```sh
bun script/desktop-release.ts verify-public \
  --review "$DESKTOP_WORK/public-review.json" \
  --expected-review-sha256 "$APPROVED_PUBLIC_REVIEW_DIGEST" \
  --output "$DESKTOP_WORK/verified-selection"
```

This command is read-only outside its new local output directory. It never publishes or updates the website. Do not call the separate website promotion command on the robot laptop as part of candidate validation.

The producer and website share this strict selection contract: schema version 1, repository `PhysicalSystems/physicalsystems`, and a selected release with `tag`, `version`, `channel`, `releaseId`, `publishedAt`, `sourceRevision`, `inputsSha256` and `assets`. Each asset has `name`, `bytes`, and `sha256`; all three exact x64 filenames from the candidate inventory are required. URLs are resolved from matching public GitHub metadata rather than invented for unpublished candidates.
