# Browser factory diagnostic

Use the existing **Prepare desktop candidate (no publication)** workflow with
`browser_factory_diagnostic=true`. Choose `browser_factory_platform=linux-x64`
(the default) or `windows-x64`. Select the reviewed source branch and provide
its exact full commit in `source_sha`; the source must equal the workflow revision.
The diagnostic uses one fresh GitHub-hosted runner: Ubuntu 24.04 with the runner's
Google Chrome/Xvfb, or Windows 2025 with its installed Microsoft Edge. It uses
pinned Bun. Its imports need only built-ins and local
TypeScript, so it skips workspace dependency installation and Electron downloads.

Diagnostics use a separate concurrency group for each reviewed branch and selected
platform, so they can run alongside a full candidate build. Candidate version
allocation remains serialized in `desktop-release-candidate`. Neither group
cancels a running job when another dispatch arrives.

By default this mode skips candidate preparation, packaging and qualification. It calls the
same `startOwnedReviewBrowser` or `startOwnedWindowsReviewBrowser` factory used by native smoke, waits for its owned
`about:blank` target, then calls its ownership-checked `stop()` exactly once. It
does not call an opener, navigate to a provider, sign in, build or install the
desktop app. Successful completion is not desktop or public release evidence.
Existing PR source checks still validate the pushed revision independently.

In the default acquisition mode, a fixed validated loopback sentinel selects the **HTTP** association used by the
inert handoff test; the sentinel is never opened, fetched or navigated to. Only
`about:blank` is loaded. Windows verifies its current HTTP handler and temporarily
registers a per-user launch command for the same signed Edge executable with its
exclusive, non-default profile. It restores the exact previous registration only
after confirmed process cleanup. Existing profile policies or alternate activation
handlers prevent acquisition; they are never disabled. This does not test HTTPS
provider routing, a real browser handoff, or sign-in. It never changes the default
browser association.

An explicit `browser_factory_loopback=true` together with
`browser_factory_diagnostic=true` and `browser_factory_platform=windows-x64`
adds an **OS-only loopback handoff**. Other combinations fail before acquisition.
It uses the same owned Edge factory and a fresh, exclusive loopback HTTP server.
One fixed PowerShell adapter invokes `.NET Process.Start` with
`UseShellExecute=true` for the exact nonce URL; Microsoft documents this as the
[current user's graphical shell association](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.useshellexecute).
It accepts only the authored numeric IPv4 loopback URL and nonce path, has no
arbitrary executable, script or URL option, and leaves the existing default
association intact. A reused browser may return no process object; that return
value is never used as browser ownership evidence.

The fixed opener helper must return its acknowledgment **and close**. The
controller then requires both the exact server GET and the same owned browser's
CDP target. It issues the opener once, keeps the 12-second handoff deadline, and
drains the exact confirmation before cleanup. False, late or unconfirmed opener
outcomes retain state and release only controller handles. An unconfirmed native
helper or target read cannot authorize more native calls, launcher restoration
or profile deletion. The 13-second drain includes the existing 12-second helper
budget and 500-millisecond close allowance. These are the same close and
ownership checks used by the production factory, with an independent fixed
request type for the OS opener.

This diagnostic launches no desktop application and exercises no product IPC
opener, provider authorization, installer or credential store. Its report records
`mode: "windows-os-loopback"` and `osLoopbackHandoff: "OBSERVED"` only when both
observations succeed. Cleanup must also succeed for `result: "COMPLETE"`.
`desktop`, `productOpener`, the product `browserHandoff`, and `providerLogin`
remain `NOT_TESTED`; qualification and publication remain false. The ordinary
`about:blank` mode is unchanged and reports `osLoopbackHandoff: "NOT_TESTED"`.

Windows reserves one loopback port and releases its reservation immediately before
launching Edge with that exact port. The adapter verifies the browser's process
identity, profile, debugging arguments and native listener ownership before any
DevTools request. It neither scans ports nor relies on a `DevToolsActivePort` file.
An occupied port, stripped debugging arguments or uncertain reservation cleanup
remains a failure.

Before the Windows browser run, a focused PowerShell regression executes the
production process-exit reconciliation helper with inert callbacks. It checks
confirmed absence, live or unreadable PIDs, malformed proofs and identity
mismatches without querying or stopping real processes. The same fixture shadows
the listener cmdlet to distinguish successful empty queries from failed or partial
queries. Production uses an exact-port CIM query with terminating errors; a failed
query can never become an empty listener result.

The fixture constructs its error records before expected-error handling and checks
that `Continue` returns while the production `Stop` query throws the exact error.
Separate inert child-process tests require the native helper's `close` event;
an early completion callback cannot authorize another helper or cleanup.

The same early step checks the installer partial-copy watcher using inert files
and fake processes. Its fixture sequences a real absent-file observation before
writing partial target bytes and holds a descendant query until interruption is
requested. No installer runs. This catches Windows-specific lifecycle regressions
before the full candidate spends time installing build dependencies.

Inert filesystem tests also verify native file identities and bounded private-root
removal, including directory replacement and junction/symlink preservation. These
tests do not open a browser. Actual cleanup still requires settled handoff reads,
confirmed process shutdown and exact launcher restoration before deleting a profile.

Windows startup stderr is drained privately and classified within 64 KiB. Only
fixed message categories and a truncation flag enter the report. A message saying
DevTools is listening cannot establish ownership or authorize a CDP request.
Cleanup failures preserve an allowlisted filesystem error category; they never
include filenames or raw native error text.

The five-minute job includes a 90-second Linux command deadline or a four-minute
Windows step deadline. Windows allows 30 seconds for the read-only preflight,
which includes native signature verification; registration writes, observations,
process stopping and registration restoration retain their 12-second operation limits.
The transport allows a further 500 milliseconds to confirm helper closure. If
closure remains unconfirmed, that adapter permanently refuses subsequent native
operations and private state is retained.
The longer outer deadline leaves room for ownership checks and cleanup. Signature
requirements and native trust/network behavior are unchanged; the native
transport does not retry operations when their deadlines expire. It uploads
only `browser-diagnostic.json` under an artifact named
`desktop-browser-diagnostic-<linux|windows>-<run>-<attempt>`, retained for seven days.
The report binds the exact source/run/attempt/platform and HTTP association scope, and records acquisition, cleanup,
fixed failure phases, safe error categories, counts and booleans. Desktop,
product opener, product browser handoff and provider login remain `NOT_TESTED`; qualification and
publication remain false. An interrupted command leaves an explicit `INCOMPLETE`
report. Inspect the job's timeout outcome alongside that report.

The Windows adapter compresses its fixed, reviewed script into the inline command
to stay below CreateProcess's 32,767-character limit. The bootstrap reconstructs
that exact source; requests remain JSON on stdin. It adds no execution-policy
override or external script file. Round-trip tests and the hosted inert fixture
exercise the same transport before the browser is acquired.

The factory retains uncertain browser/profile ownership and releases the
controller's child handle. The diagnostic never retries cleanup or deletes the
retained profile itself. No browser profile, raw log, process command line,
credential, URL or environment dump is uploaded. GitHub destroys the disposable
runner afterward. Do not run this native command on an operator computer or
self-hosted runner; local regressions use inert factory/child callbacks and owned loopback sockets only.

For a Windows OS-loopback diagnostic, the existing optional
`diagnostic_public_key` input can enable one encrypted snapshot of an unknown
executable. The strict existing RSA-SPKI recipient validator runs before any
private collector is enabled. No key means no snapshot collection. The factory
provides at most eight executable paths and PID/parent pairs with fixed ownership
booleans; it provides no arguments, URLs, SID strings, environment, credentials
or profile contents. These fields never enter the sanitized report or raw logs.

After the final sanitized `browser-diagnostic.json` is written, the controller
uses the existing `sealDiagnostics` AES-GCM/RSA-OAEP implementation to encrypt the
snapshot. Its authenticated `artifactSha256` is the SHA-256 of those exact
**sanitized receipt bytes**, not an installer digest. The envelope also binds the
source revision, run and attempt. Independently hash the downloaded receipt and
verify all bindings before decryption. The output is named
`<receipt-sha256>.sealed.json` and uploaded only in the separate
`desktop-browser-sealed-windows-<run>-<attempt>` artifact, retained for three days.
The exclusive temporary `diagnostic.txt` is removed after sealing, including
failed sealing. Only ciphertext and fixed status metadata are uploaded or logged.
No private key reaches the runner, and this optional diagnostic adds no
qualification or publication authority.
