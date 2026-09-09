# Physical Systems integration for OpenCode Desktop

This is a local development integration and an unpacked review target. OpenCode supplies the Electron/Solid desktop, conversations, model/provider selection, Markdown, and terminal client. Physical Systems supplies the project/workcell controls and the authority for physical operations. The local Ubuntu Electron flow has been exercised with a deterministic provider and device access disabled. Windows and real-provider/native credential qualification remain open. See `QUALIFICATION.md` for exact evidence and remaining limits.

## Source and authority boundaries

The canonical public Physical Systems repository owns `packages/operator-service`, `packages/operator-core`, the public workcell/experiment controllers, public Node clients, and reviewed skills. Change that source first. `script/build-operator.ts` produces the fork's `vendor/operator-service.mjs`, skill files, notices, and `vendor/manifest.json`; the manifest records the canonical Git revision, dirty state, source hashes, and artifact hashes. Do not hand-edit the generated bundle. A dirty manifest describes a development snapshot, not a reviewed immutable source revision.

This fork owns the adapter code in this package, `packages/desktop/src/main/physical*.ts`, the narrow preload IPC bridge, the OpenCode agent/tool guards, and `packages/app/src/physicalsystems`. It does not contain the private Node implementation, device drivers, commissioning implementation, or hosted service control plane. The canonical repository's `BOUNDARY.md` remains the source boundary. Project-authored integration code is Apache-2.0; upstream OpenCode and third-party components retain their existing licenses and notices.

The main process owns separate encrypted provider and operator credential vaults. A utility process runs the canonical operator service. The owned OpenCode server calls its private loopback gateway with trusted session context. The renderer receives typed snapshots and submits narrow commands; it receives no agent bearer token. Agent permissions deny general shell, arbitrary tools, and unreviewed MCP access in this profile. The `physical-systems` agent uses the reviewed inspection, planning, skill, and synthetic experiment tools. Adopting the agent does not create hardware or commissioning authority.

A Physical Systems project has its own stable ID and explicit OpenCode server/session bindings; a working directory alone is not an operation owner. First-tool binding verifies the actual session on the owned server and requires an unambiguous canonical directory match. Ambiguity requires an explicit desktop binding. Proposals and tool text grant no authority. Approval uses the exact plan/operation digest and scope, and continuation retries retain their recorded request ID. The Stop/recovery controls live above the conversation connection gate and retain the recorded owner across navigation.

The project's compose action creates an empty OpenCode session on the owned local server, binds it to the project, and opens its native tab. **View devices** selects an existing binding or creates one before opening Devices, so operator controls are available before a chat prompt. Creating this context sends no model prompt and does not connect a Node or start a capture. Existing upstream drafts and conversation tabs remain managed by OpenCode.

## Developer build and launch

Use the repository's installed Bun toolchain and dependencies. Run these commands from the fork root. The canonical source path and model-catalog path must identify the reviewed local inputs you intend to build:

```sh
bun packages/physicalsystems/script/build-operator.ts /absolute/path/to/physicalsystems
OPENCODE_VERSION=0.0.0-physical-review.1 OPENCODE_CHANNEL=dev MODELS_DEV_API_JSON=/absolute/path/to/models.dev-api.json bun packages/opencode/script/build-node.ts
```

The second command builds the OpenCode server into `packages/opencode/dist/node`. Its existing generator fetches `https://models.dev/api.json` if `MODELS_DEV_API_JSON` is omitted; supplying a saved JSON snapshot makes that input explicit. The catalog is model/provider metadata, not bundled model weights, free inference, or configured credentials.

Build the desktop from its package directory:

```sh
cd packages/desktop
bun ./node_modules/electron-vite/bin/electron-vite.js build
```

This invokes the installed builder directly after the explicit server build. The upstream `bun run build` lifecycle also runs `scripts/prebuild.ts`, which copies channel assets, rebuilds the server, and may download upstream CLI resources. The local review launcher does not need that downloaded CLI. The Electron build copies the prebuilt server and WASM assets, bundles the operator adapter, and builds the renderer. It does not install or launch a Node service.

From the fork root, launch with a dedicated absolute data directory:

```sh
bun packages/physicalsystems/script/dev.ts /absolute/path/to/isolated-physicalsystems-review
```

The launcher verifies the manifest's vendor artifact hashes, launches the already-built Electron app, and forces `PHYSICALSYSTEMS_ALLOW_DEVICES=0`. It does not rebuild stale desktop output; rebuild after source or vendor changes. The main process uses a separate application identity and places desktop/session files, OpenCode XDG data/config/cache/state, workspaces, and operator records under the supplied root. Ambient provider credentials and OpenCode configuration are filtered by `src/environment.ts`; this profile does not adopt the installed OpenCode application's accounts or data.

Device connections remain disabled in this review path, including local and SSH Node connections. Synthetic experiments use the public numeric fixture. Enabling device access requires a separately authorized development run and qualification; the launcher deliberately overrides an inherited enabling value. Provider setup and model calls are separate choices in OpenCode's existing UI.

`packages/desktop` also has `package`, `package:linux`, `package:win`, and `package:mac` scripts using `physical-review.config.ts`. These prepare unpacked review applications with a separate ID/name, no publishing feed, and no signing/notarization claim. Their existence does not establish installer or platform qualification.

## Attach a terminal to the desktop session

Select a bound Physical Systems conversation in the running desktop, then run from the fork root:

```sh
bun packages/physicalsystems/script/attach.ts /absolute/path/to/isolated-physicalsystems-review
```

This reads `desktop/runtime-attach.json`, verifies the local attachment file and live owner process, and launches the fork's OpenCode `attach` client for that exact directory and session. The attachment credential is passed through the child environment, not a command-line password. The file is private runtime material; do not publish it or include it in ordinary evidence. Attaching does not start a second operator service or replay a conversation. The canonical Pi-based CLI remains a separate compatibility client; this attachment script uses the fork's OpenCode terminal client.

## Imported history and rollback

The Projects footer's **Imported history** flow opens a native directory picker. Main reads a bounded, stable legacy catalog and its referenced transcripts, then issues a short-lived preview token tied to that renderer. Only explicit import writes a content-addressed archive under `desktop/legacy-imports`. Originals are preserved; the target cannot be inside the source tree. Repeating the same import preserves the existing identical archive.

Imported conversations, parent relationships, and saved drafts are read-only evidence. Connections are shown offline. Images, raw tool payloads, reasoning, and credential storage are excluded; recognizable credential patterns in text are redacted. Imported approval prose never enters ToolRegistry or authorizes an operation. Draft reuse is an explicit copy/paste action into a new conversation, with no automatic submission. Large histories render conversation bodies on opening and page their entries.

There is no in-place conversion of the legacy data directory. To roll back the UI migration, close the review application after owned operations are settled and reopen the old client against its preserved original data. Preserve the isolated review directory if new work or evidence must be retained. Removing an imported copy does not undo new OpenCode conversations, Node activity, or credentials created separately. Do not delete ownership records to make an unresolved operation disappear.

## Recovery and qualification limits

When an operator worker exits, the UI retains owned operations as unavailable and exposes explicit **Recover service**. Recovery reconstructs the canonical service from persisted records, leaves connections offline, and keeps the OpenCode model server separate. A replacement service identity is accepted by the UI only after that explicit recovery response. Known operation IDs can be reconciled against their original owner; recovery is not a replay mechanism.

Shutdown waits for the canonical service and gateway to acknowledge close, then finishes queued attachment writes and removes the attachment credential. Only after that cleanup does the main process invoke `kill()` on its owned Electron utility process, avoiding another worker IPC exit handler. This is owner-directed termination after cleanup: pinned Electron 42.3.3 sends SIGTERM on Linux and Chromium's existing reaper can send SIGKILL after two seconds. The app still requires the original worker exit event within 6.5 seconds; neither the stop return value nor a diagnostic marker confirms exit. Failed cleanup prevents termination, and unconfirmed exit keeps shutdown blocked. Callback tests cover this ordering; hosted package qualification checks the native behavior.

If camera Start or execution Prepare failed before an operation ID was acknowledged, the service retains an unknown-outcome recovery record with `canStop: false`. It cannot safely guess another camera capture or run ID. Inspect the original Node using its independent operational procedure and retain its evidence. This limitation prevents claiming that generic recovery or Stop has confirmed an unidentified operation's settlement.

For package-local checks, use `bun test src` and `bun typecheck` in this package; use `bun typecheck` in `packages/app` and `packages/opencode` for their respective changes. `packages/app/test-browser/physicalsystems-ui.test.ts` is an opt-in isolated Solid fixture (`PHYSICALSYSTEMS_UI_BROWSER_TESTS=1`), using fake IPC and Firefox/WebDriver. `test/native-smoke.mjs` is an opt-in actual-display Electron harness with an inert local provider and device access disabled. Neither harness qualifies physical equipment. Keep generated evidence outside the source tree and run heavyweight type checks sequentially on memory-limited machines.

The review target forces device access off, uses the pinned local Electron distribution and prebuilt native dependencies, and includes operator provenance and MIT/Apache notices. It has no source-map upload plugin, telemetry upload, signing or publication feed. Windows, native credential behavior, installed update/rollback and real-device execution remain unqualified. An unpacked review directory is not an installer release. Full results and artifact identity are recorded in `QUALIFICATION.md`.
