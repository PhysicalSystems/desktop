# Building installers under the public identity

`script/desktop-build-public.ts` builds Windows x64 or Linux x64 installers from
the committed source identified by two independently anchored input records.
It does not publish, start the application, or grant native qualification.

Prepare ordinary `ReleaseInputs` from the exact clean commit containing the
public build implementation, retaining its `history.json` and decoded
`models.dev-api.json`. Prepare `PublicBuildInputs` with the same source revision,
release-input digest, version and channel, the fixed public desktop identity,
and an explicit signing policy. Obtain both expected digests from the trusted
preparation step. A digest taken only from an untrusted downloaded record does
not establish approval or trust.

Run on the target operating system with the pinned Bun and Electron versions:

```sh
bun script/desktop-build-public.ts \
  --inputs /absolute/release-inputs/release-inputs.json \
  --public-inputs /absolute/public-build-inputs.json \
  --expected-inputs-sha256 "$DESKTOP_RELEASE_INPUTS_SHA256" \
  --expected-public-build-sha256 "$DESKTOP_PUBLIC_BUILD_SHA256" \
  --platform linux-x64 \
  --output /absolute/new-public-installers
```

Use `windows-x64` on Windows. Its pinned signing policy requires either:

- PFX: an absolute regular `PHYSICALSYSTEMS_PFX_FILE` and runner-only
  `WIN_CSC_KEY_PASSWORD`;
- Azure Trusted Signing: the provisioned `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`
  and `AZURE_CLIENT_SECRET`, matching the owned endpoint/account/profile in the
  public policy.

Missing Windows signing setup fails before a build starts. Credentials are
passed only to the final packaging subprocess. Installation and bundling receive
scrubbed environments; credentials and ambient loader hooks are excluded.
There is no unsigned fallback or command-line publishing option.

The driver snapshots validated inputs outside source, stages the exact Git
archive, installs frozen dependencies without lifecycle scripts, and compiles
with the public identity. Public packaging requires the compiled main-process
hash and matching public-input digest; existing candidate outputs cannot be
relabeled. The candidate build command and application identity remain separate.

Output must be a new or empty directory outside the source checkout. Successful
builds retain only the expected installers, `artifacts.json`, `SHA256SUMS`, both
input records, and `public-build-record.json`. The record reports
`signing.status: NOT_VERIFIED`, `qualification: NOT_TESTED`, and
`publication: false`. No credentials, temporary dependency tree or signer debug
files are copied to output.

The actual installer and executable signatures, native credential storage,
provider sign-in, installation/upgrade/recovery and other distribution checks
must be qualified afterward on the exact output bytes. This build record cannot
substitute for `QualifiedDistribution` or authorize public release promotion.
