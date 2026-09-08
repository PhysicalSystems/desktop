# Browser factory diagnostic

Use the existing **Prepare desktop candidate (no publication)** workflow with
`browser_factory_diagnostic=true`. Choose `browser_factory_platform=linux-x64`
(the default) or `windows-x64`. Select the reviewed source branch and provide
its exact full commit in `source_sha`; the source must equal the workflow revision.
The diagnostic uses one fresh GitHub-hosted runner: Ubuntu 24.04 with the runner's
Google Chrome/Xvfb, or Windows 2025 with its installed Microsoft Edge. It uses
pinned Bun. Its imports need only built-ins and local
TypeScript, so it skips workspace dependency installation and Electron downloads.

This mode skips candidate preparation, packaging and qualification. It calls the
same `startOwnedReviewBrowser` or `startOwnedWindowsReviewBrowser` factory used by native smoke, waits for its owned
`about:blank` target, then calls its ownership-checked `stop()` exactly once. It
does not call an opener, navigate to a provider, sign in, build or install the
desktop app. Successful completion is not desktop or public release evidence.
Existing PR source checks still validate the pushed revision independently.

A fixed validated loopback sentinel selects the **HTTP** association used by the
inert handoff test; the sentinel is never opened, fetched or navigated to. Only
`about:blank` is loaded. Windows verifies its current HTTP handler and temporarily
applies the existing factory's owned Edge profile policy, restoring the exact
previous policy only after confirmed process cleanup. This does not test HTTPS
provider routing, a real browser handoff, or sign-in. It never changes the default
browser association.

Windows reserves one loopback port and releases its reservation immediately before
launching Edge with that exact port. The adapter verifies the browser's process
identity, profile, debugging arguments and native listener ownership before any
DevTools request. It neither scans ports nor relies on a `DevToolsActivePort` file.
An occupied port, stripped debugging arguments or uncertain reservation cleanup
remains a failure.

Before the Windows browser run, a focused PowerShell regression executes the
production process-exit reconciliation helper with inert callbacks. It checks
confirmed absence, live or unreadable PIDs, malformed proofs and identity
mismatches without querying or stopping real processes.

The five-minute job includes a 90-second Linux command deadline or a four-minute
Windows step deadline. Windows allows 30 seconds for the read-only preflight,
which includes native signature verification; policy writes, observations,
process stopping and policy restoration retain their 12-second operation limits.
The longer outer deadline leaves room for ownership checks and cleanup. Signature
requirements and native trust/network behavior are unchanged; the native
transport does not retry operations when their deadlines expire. It uploads
only `browser-diagnostic.json` under an artifact named
`desktop-browser-diagnostic-<linux|windows>-<run>-<attempt>`, retained for seven days.
The report binds the exact source/run/attempt/platform and HTTP association scope, and records acquisition, cleanup,
fixed failure phases, safe error categories, counts and booleans. Desktop,
browser handoff and provider login remain `NOT_TESTED`; qualification and
publication remain false. An interrupted command leaves an explicit `INCOMPLETE`
report. Inspect the job's timeout outcome alongside that report.

The factory retains uncertain browser/profile ownership and releases the
controller's child handle. The diagnostic never retries cleanup or deletes the
retained profile itself. No browser profile, raw log, process command line,
credential, URL or environment dump is uploaded. GitHub destroys the disposable
runner afterward. Do not run this native command on an operator computer or
self-hosted runner; local regressions use inert factory callbacks only.
