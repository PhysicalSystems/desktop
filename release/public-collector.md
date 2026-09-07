# Public qualification collector

`script/desktop-public-collect.ts` builds the existing publisher's flat bundle
from independently anchored package, smoke and native-check evidence. It never
launches, signs, installs or publishes an application. It does not change a smoke
receipt's `UNQUALIFIED` result into evidence that native checks ran.

The collector is implemented, but **the public workflow is not wired to produce
its complete inputs or invoke it**. Current smoke alone remains insufficient.
The native job must actually implement every required check; the first public
upgrade baseline policy also remains unresolved. Adding a receipt or calculating
its own expected hash cannot establish that a native check passed.

## Trusted inputs

The exported `PublicCollectionPlan` in
`packages/physicalsystems/src/release/public-collector.ts` binds one run ID,
attempt, source revision, public-build digest and release-input digest. Its three
artifact entries contain the exact installer name, byte count and SHA-256, plus
the **raw-file** SHA-256 of that artifact's smoke and native receipts.

The reviewed coordinator must construct this plan from trusted native/build job
outputs. Its **canonical JSON** digest must reach the collector separately from
the downloaded plan. The public-build digest, release-input digest, source and
run identity are independent arguments as well. The collector checks all these
bindings and validates public identity using the existing public-build validator.

`PublicNativeReceipt` is a fixed, sanitized receipt with:

- `schemaVersion: 1` and `kind: "public-desktop-native-qualification"`.
- The plan's exact `runId`, `runAttempt`, `sourceRevision`,
  `releaseInputsSha256` and `publicBuildInputsSha256`.
- The same `{ name, bytes, sha256 }` artifact, fixed public desktop identity and
  `windows-x64` or `linux-x64` platform.
- Exactly the existing eight required native check IDs, each with only `id` and
  `status`. Every status must be `PASS` to collect a bundle. Duplicate, missing,
  unknown, failed or untested checks are rejected.

The native receipt's origin and factual truth rely on the reviewed native job and
its separately trusted raw digest. The collector validates bindings and outcomes;
it does not infer an operating-system test from booleans or fixture activity.
Native reports contain no arbitrary observations, profiles, credentials or logs.

## Directory and output contract

The evidence directory must contain **only** the three installers and their smoke
and native receipts, each receipt named `<raw-sha256>.json`. Plan and public input
files are supplied separately. Unexpected files, symlinks, changed bytes,
candidate identity and inconsistent Windows signers are rejected. No source file
is executed, edited or copied into a system installation.

The output must be a new directory outside the evidence directory and checkout.
Only after every input validates does the collector copy installers and create:

- `qualified-distribution.json`, using the existing `QualifiedDistribution` and
  `PublicDistributionFacts` validators.
- Three synthesized artifact reports containing fixed check IDs, statuses and
  input-evidence digests; raw smoke detail strings are omitted.
- One synthesized Windows signature report, preserving the verified installer
  and executable identities, and one aggregate qualification summary.

The five reports use their raw SHA-256 filenames. The completed bundle is checked
again by `verifyQualifiedBundle`; its canonical qualified-distribution digest is
written to the trusted `qualification_sha256` job output and summary. Existing
output directories are never replaced. The publisher still requires a successful
owned producer run, the exact source/attempt and its protected final approval.

```sh
bun script/desktop-public-collect.ts \
  --plan "$COLLECTION_PLAN" --expected-plan-sha256 "$TRUSTED_PLAN_SHA256" \
  --public-inputs "$PUBLIC_BUILD_INPUTS" \
  --expected-public-build-sha256 "$TRUSTED_PUBLIC_BUILD_SHA256" \
  --expected-inputs-sha256 "$TRUSTED_RELEASE_INPUTS_SHA256" \
  --source-sha "$TRUSTED_SOURCE_SHA" \
  --run-id "$TRUSTED_RUN_ID" --run-attempt "$TRUSTED_RUN_ATTEMPT" \
  --evidence "$SANITIZED_COLLECTION_INPUTS" --output "$NEW_QUALIFIED_BUNDLE"
```

Workflow integration must still supply the actual native evidence, call the
collector, upload `desktop-public-qualified-<run-id>-<attempt>`, and allow the
producer to succeed only after collection verifies. The CLI does not enable or
dispatch the publisher. Collector tests use explicitly simulated installer bytes,
signatures and native receipts; they do not qualify a real desktop distribution.
