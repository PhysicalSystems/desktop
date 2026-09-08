# Linux browser factory diagnostic

Use the existing **Prepare desktop candidate (no publication)** workflow with
`browser_factory_diagnostic=true`. Select the reviewed source branch and provide
its exact full commit in `source_sha`; the source must equal the workflow revision.
The diagnostic uses a fresh Ubuntu 24.04 GitHub-hosted runner, pinned Bun, the
runner's Google Chrome and Xvfb. Its imports need only built-ins and local
TypeScript, so it skips workspace dependency installation and Electron downloads.

This mode skips candidate preparation, packaging and qualification. It calls the
same `startOwnedReviewBrowser` factory used by native smoke, waits for its owned
`about:blank` target, then calls its ownership-checked `stop()` exactly once. It
does not call an opener, navigate to a provider, sign in, build or install the
desktop app. Successful completion is not desktop or public release evidence.
Existing PR source checks still validate the pushed revision independently.

The five-minute job includes a 90-second diagnostic command deadline. It uploads
only `browser-diagnostic.json` under an artifact named
`desktop-browser-diagnostic-linux-<run>-<attempt>`, retained for seven days.
The report binds the exact source/run/attempt and records acquisition, cleanup,
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

Windows diagnostics are outside this small Linux acquisition/cleanup path.
