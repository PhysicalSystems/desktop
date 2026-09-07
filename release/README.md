# Physical Systems Desktop candidates

This pipeline prepares **internal, unsigned desktop candidates**. It has no publication, tag creation, package publishing, website mutation, signing credentials or update-enabling step. Its GitHub token has `contents: read`. A successful candidate run is evidence for review; it is not authorization or qualification for a public release.

The desktop has its own version sequence, initially `0.1.0-beta.1`. It bundles the pinned OpenCode agent server and public Physical Systems operator artifact. Desktop candidate preparation does not rebuild, discover, install or upgrade a hardware-host Physical Systems Node. The existing npm and private Node release processes remain separate.

## Fork workflow ownership

The inherited OpenCode workflows retain their original conditions and also require `github.repository == 'anomalyco/opencode'` on every job. This prevents upstream maintenance bots, tests and publishing jobs from running in the Physical Systems fork, including jobs using `always()`. The three owned `desktop-*.yml` workflows provide this fork's source checks, internal candidate preparation and disabled public-download promotion. Preserve these guards when updating from upstream; review newly added upstream jobs before enabling them.

## Maintainer workflow

1. Commit and review the desktop source, including the vendor manifest and release policy. Source and bundled artifacts must be clean and their hashes must match. Make this commit available in the desktop repository before requesting a CI candidate.
2. Dispatch **Prepare desktop candidate (no publication)** with its full lowercase commit SHA. The default track is `preview`; an empty version allocates the next preview from the public download repository's fully paginated visible `desktop-v*` release history. `stable` requires an explicit version and still produces only an internal candidate.
3. The prepare job reads every page of this repository's releases, including prereleases and any drafts visible to its read credential, and creates one immutable input bundle. Unrelated upstream release tags are excluded. A failed or incomplete history read cannot be treated as an empty history. A source-repository token may not see drafts in the separate public destination; candidate allocation remains provisional and the protected public publisher must check all draft/tag reservations with the appropriate credential.
4. Required source checks run against that exact SHA. The Windows x64 and Linux x64 package jobs then run in parallel, consuming the same inputs and tracked model catalog. Packaging always uses `--publish never` and the Physical Systems candidate configuration.
5. Each platform qualifies the exact generated files, then verifies artifact hashes against the sanitized qualification receipts. No replacement build occurs after qualification. Download the candidate assessment and per-platform reports before using the installer artifacts for internal review.

The dispatch is serialized to avoid concurrent version allocation. Because this workflow does not reserve tags or create draft releases, an unpublished version remains provisional and may recur in a later candidate run. Run ID, attempt, source SHA and artifact digest identify a candidate. A future publisher must independently recheck version and tag availability before publication; never relabel an existing binary as a new version.

All jobs check out a fixed SHA. Download caches are keyed by OS, architecture, Node/Bun pins and the lockfile. They contain package, Electron and packaging-tool downloads; they do not contain installed-app profiles, native outputs shared between platforms, credentials or test evidence. Dependencies install with `--frozen-lockfile --ignore-scripts`; the allowlisted preparation step downloads the locked Electron binary explicitly. The workflow does not invoke upstream desktop prebuild or publishing hooks.

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

For Windows, use `--platform windows-x64` on a disposable Windows runner and omit `xvfb-run`. The NSIS install smoke is CI-only and targets a fresh temporary directory. It must not be redirected to an existing installation. Linux qualification extracts each `.deb` and AppImage and launches its payload; this does not qualify system package-manager installation, FUSE operation or desktop integration.

The source checks use `bun test` and `bun typecheck` from the affected package directories. Root-level `bun test` is intentionally unsupported in this monorepo. Upstream publishing scripts and the canonical `check:release-packages` command are not part of this desktop workflow.

## Inputs, artifacts and evidence

The input bundle contains `release-inputs.json`, `history.json`, the decoded `models.dev-api.json`, and `SHA256SUMS`. The record fixes the desktop version/channel, repository and source commit, OpenCode baseline, canonical operator revision/digests, lockfile, toolchain, model catalog and compatibility declarations. Both platforms verify these bytes before building. A platform does not refresh its model catalog independently or rebuild the operator from a developer-local checkout.

In GitHub Actions, every consuming CLI command also requires `PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256` and `PHYSICALSYSTEMS_RELEASE_REPOSITORY`. The expected digest comes from the trusted prepare job's output, and the repository comes from the workflow context. They must not be derived from the downloaded record being checked: a self-consistent replacement record is insufficient. Local diagnostics still verify the record against source and may supply the same anchors explicitly.

| Target                        | Files prepared   | Automated qualification boundary                                                                     |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| Windows x64 on `windows-2025` | NSIS `.exe`      | Fresh temporary installation and packaged simulation checks; no signing or real provider credentials |
| Linux x64 on `ubuntu-24.04`   | `.deb`, AppImage | Separate extracted-payload launches under Xvfb and packaged simulation checks                        |

Each platform retains the exact installer files, `artifacts.json`, `SHA256SUMS`, per-artifact qualification JSON and a verification report. Failure paths retain available sanitized receipts and `workflow-status.json`; a skipped or missing required check cannot become a pass. The final assessment collects both platform reports and retains `summary.json`, `summary.md`, checksums and `candidate-downloads.json`.

`candidate-downloads.json` is review metadata: publication is disabled and download URLs are unset. It is not the public website's selected-release manifest. Artifacts use run/attempt-specific names and 30-day retention. Preserve a reviewed, sanitized evidence bundle in the eventual durable release record before relying on it beyond that retention period.

Temporary app profiles, credentials, runtime attachment files, browser logs and screenshots are excluded from workflow uploads. Qualification uses a local inert provider and synthetic experiments, with hardware access disabled. Those results do not verify real provider authentication, cameras or robot behavior. Headless UI blanking checks do not measure optical/display flicker.

## Public release blockers and follow-up

The candidate identity is deliberately `Physical Systems Candidate`, using the development application identity. The preview/stable application IDs, data directories, migration rules and branding must be settled before public distribution. The workflow does not imply that those decisions have been made.

Public release remains blocked until the applicable evidence and infrastructure exist:

- Run and review the new CI workflow on both target platforms. Local unit or configuration validation does not substitute for Windows installer execution.
- Provision the owned Windows signing identity, sign before qualification and verify both installed executable and final installer signatures. Unsigned candidate receipts are always described as unsigned.
- Qualify provider browser opening and native credential storage on supported OS profiles. Fixture-provider tests and fake encryption are separate evidence.
- Qualify actual supported OS versions, Linux installation/launcher behavior, X11/Xwayland and Wayland display behavior, plus clean-machine operation without developer Node/Bun in the installed application's runtime path.
- Exercise fresh installation, upgrade from a previously qualified desktop, failed/interrupted upgrade recovery, uninstall/reinstall, preserved history/configuration and unresolved operation ownership in disposable environments.
- Verify the declared desktop/operator/Node compatibility and canonical operator source/provenance. Declared or unverified compatibility must not be advertised as tested hardware support.
- Add the signed public publisher described below. It must publish the approved artifact bytes and public review record without rebuilding. The implemented, disabled download-promotion workflow then verifies public bytes and opens a website selection PR; it cannot qualify or publish an unsigned candidate.

The first public preview should retain manual updates until installation lifecycle checks pass. Any later in-app updater must use owned feeds, verify the expected publisher, prohibit automatic downgrade, and respect confirmed shutdown/operation ownership. A desktop update must never silently restart a hardware session or upgrade its Node service. This candidate workflow neither enables nor qualifies in-app updates.

## Website download integration

The public installer destination is **PhysicalSystems/physicalsystems**, matching the existing `PhysicalSystems/platform` download page. Desktop source may live in its separate fork. The existing npm and Node releases remain independent; the website looks up the selected exact `desktop-v${version}` tag, so newer npm releases cannot displace a desktop download.

The companion website change is based on platform `main` at `6d41e1c`. It introduces `public/desktop-selection.json`, initially `release: null`. The page offers only installers matching that controlled selection and live GitHub metadata. It retains the last checked selection within an open page when a refresh fails, with an explicit notice. A successful empty selection withdraws the buttons. It does not verify installer bytes or Windows signatures inside the browser.

The integration path is implemented locally, but **disabled by default**:

1. A future signed public publisher at `.github/workflows/desktop-public-release.yml` must qualify the actual public build, obtain approval, publish the exact artifacts and retain `public-review.json` as the sole file in `desktop-public-review-${run_id}-${run_attempt}`. That publisher is not implemented by the candidate workflow.
2. `.github/workflows/desktop-download-promotion.yml` accepts the exact completed publisher run/attempt, source SHA and the **canonical** review digest from its trusted summary. It checks the publisher identity and requires a protected `desktop-download-promotion` environment with reviewers. It can be dispatched separately or called by a coordinator after the publisher run has completed successfully; a publisher cannot call this synchronously inside its own still-running run.
3. `verify-public` rejects candidate/development identities, unsigned evidence and incomplete public qualification. It anonymously reads the exact public release and streams each of the three installer files, checking size and SHA-256 against the independently anchored review. It produces `desktop-selection.json` only after all downloads match. Timeouts, missing assets, unexpected redirects or changed bytes produce no selection.
4. The protected promotion job verifies the output digest again and runs `script/desktop-promote-website.ts`. With a separately scoped `DESKTOP_WEBSITE_TOKEN`, it creates or resumes a release-specific branch and one-file PR in `PhysicalSystems/platform`. It does not write `main`, merge the PR or deploy. It refuses downgrades, replacement bytes under an existing version, stable-to-preview switching and unrelated branch changes.
5. The website's normal checks, review, merge and deployment make the approved selection live. Failed verification or an unmerged PR leaves the current download selection unchanged. This is automatic PR preparation, not unattended production deployment.

The workflow is skipped unless `DESKTOP_DOWNLOAD_PROMOTION_ENABLED` is exactly `true`. No environment, token, signing identity or repository setting was provisioned here. The source snapshot's development identity is intentionally ineligible for this public path. A JSON field saying approved is insufficient: `PublicDistributionReview` must come from the protected public-distribution process, and its expected canonical digest must be obtained independently. The readback helper validates that trusted evidence and byte identity; it does not itself grant approval or perform native signature qualification.

```sh
bun script/desktop-release.ts verify-public \
  --review "$DESKTOP_WORK/public-review.json" \
  --expected-review-sha256 "$APPROVED_PUBLIC_REVIEW_DIGEST" \
  --output "$DESKTOP_WORK/verified-selection"
```

This command is read-only outside its new local output directory. It never publishes or updates the website. Do not call the separate website promotion command on the robot laptop as part of candidate validation.

The producer and website share this strict selection contract: schema version 1, repository `PhysicalSystems/physicalsystems`, and a selected release with `tag`, `version`, `channel`, `releaseId`, `publishedAt`, `sourceRevision`, `inputsSha256` and `assets`. Each asset has `name`, `bytes`, and `sha256`; all three exact x64 filenames from the candidate inventory are required. URLs are resolved from matching public GitHub metadata rather than invented for unpublished candidates.
