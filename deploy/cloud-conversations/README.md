# Private cloud conversation worker

This profile runs the repository's canonical OpenCode 2.1.3 engine using Bun 1.4.4. It is a **private service behind Platform**, not a public OpenCode server. Platform owns user/team authorization, conversation-to-session IDs, quotas and prompt idempotency. The browser and desktop never receive the worker password or provider key.

`start.ts` writes a fixed `physicalsystems-cloud` agent into an isolated workspace. It launches OpenCode on loopback, verifies the actual loaded agent, then opens the service port through a restricted proxy. The proxy allows only authenticated health, policy inspection, canonical session metadata/history reads and text prompt admission. It rejects filesystem, terminal, configuration, tool approval, arbitrary agents/models/workspaces and generic OpenCode routes. Agent policy is checked again before every create or prompt. An absent or permissive agent never reaches model execution through this service.

The agent has a final deny-all tool policy, no external plugins, MCP servers, additional skills or instructions. Provider requests are text-only. `capabilities.tools=false` is descriptive; actual loaded deny-all permissions and the proxy checks enforce this boundary.

## Build and start

Pin the reviewed repository commit in the host deployment. From the repository root:

```sh
docker build -f deploy/cloud-conversations/Dockerfile -t physicalsystems-cloud-conversations .
```

The Dockerfile uses `oven/bun:1.4.4` and `bun install --frozen-lockfile --ignore-scripts`. Its Dockerfile-specific ignore file excludes local credentials, `.env` files, app state and dependency/build caches. It runs as the image's unprivileged `bun` user. Mount a persistent volume at `/state` writable by that user; `/workspace` holds only generated policy/config. Do not mount developer home directories or robot/device credentials.

Configure these server-only values through the hosting secret store:

| Worker variable | Value |
| --- | --- |
| `OPENCODE_SERVER_PASSWORD` | New independent random secret of at least 32 characters |
| `PHYSICALSYSTEMS_AI_API_KEY` | Explicitly provisioned provider key |
| `CONVERSATION_PROVIDER` | Stable provider ID also used by Platform |
| `CONVERSATION_MODEL` | Explicitly selected supported model ID; no inferred production default |
| `CONVERSATION_API_BASE_URL` | HTTPS OpenAI-compatible base URL, without credentials/query/fragment |
| `CONVERSATION_CONTEXT_TOKENS` | Optional conservative context bound, default 32768 |
| `CONVERSATION_OUTPUT_TOKENS` | Optional output bound, default 4096 |
| `PORT` | Default 4096 |

Startup is exactly `bun run deploy/cloud-conversations/start.ts`. The child's environment is constructed from an allowlist: provider and worker secrets plus isolated HOME/XDG/config/database paths. Unrelated inherited provider keys, local authentication, plugins and configuration are excluded. SQLite lives at `/state/conversations.sqlite`; keep the state volume on a single worker instance. The current session runner is process-local and is not a horizontally coordinated execution service.

The Docker health check sends authenticated `GET /api/health` to the local service port. Unauthenticated health returns 401. Do not add a public health bypass for a hosting provider; use a private TCP check if authenticated HTTP probes are unavailable. The listener is created only after policy verification.

The proxy preserves Platform's existing health and nested text-prompt contracts while translating them to V2's `server.info` and flat prompt input. The owned CLI uses a held stdin lease so it exits when the worker wrapper stops. Policy verification applies V2's last-matching permission rule and rejects session overrides that could grant tools.

## Platform connection

Set Platform's `CONVERSATION_RUNTIME_URL` to the exact private service origin and `CONVERSATION_RUNTIME_PASSWORD` to the worker secret. Match `CONVERSATION_RUNTIME_PROVIDER` / `CONVERSATION_RUNTIME_MODEL` to the worker values. Platform's production directory remains `/workspace` and agent remains `physicalsystems-cloud`.

For an isolated local fixture, the server-only `CONVERSATION_RUNTIME_DIRECTORY` may match its exact `CLOUD_WORKSPACE` path. Leave it unset for the production `/workspace` profile. No browser or native client accepts a directory override.

For a Render private service using internal HTTP, set Platform's `CONVERSATION_RUNTIME_PRIVATE_HTTP_ORIGIN` to that same verified internal origin. Keep this exception unset for public endpoints. Initially restrict `CONVERSATION_RUNTIME_ALLOWED_USERS` to the explicitly selected accounts. Never expose this worker as the public website or pass its Basic credential to a client.

A host build/start, persistent-volume permissions and private routing still need verification in the actual Linux hosting environment. This profile does not create hosting services, transfer an existing provider secret, charge an account, install a desktop release or change the running desktop app.

The `Cloud conversation worker` GitHub workflow builds this Dockerfile on Ubuntu, runs its boundary tests and typecheck, and qualifies the actual engine inside the image with Docker networking disabled. Loopback is sufficient for its synthetic provider. It publishes only synthetic evidence; it has no real provider key or desktop publishing step.

The proposed Render private Docker service is `1c-2g` (1 CPU, 2 GB RAM), currently $25/month, plus a 1 GB persistent disk at $0.25/month. Provision only after owner approval; model-provider usage is additional. The older `standard` plan name is deprecated. This deployment starts new cloud sessions; it does not import desktop history or expose live robot telemetry or robot tools.

## Local qualification without provider spending

With Bun 1.4.4 and frozen workspace dependencies installed, run unit boundaries from this directory:

```sh
bun test profile.test.ts
```

From the repository root, provide an absolute evidence directory outside the source repository:

```sh
bun run deploy/cloud-conversations/qualify.ts /absolute/path/to/evidence
```

The qualifier starts a synthetic loopback OpenAI-compatible provider and an isolated source worker. It verifies authenticated policy/health, denied general routes, exact session binding, durable prompt admission, persisted V2 assistant history, exact admission retry and that every captured provider request omits tools. No real model provider or existing local app is used. Evidence and the isolated database are retained under the supplied directory.

Add `--keep` to retain the fixture worker for browser/native gateway checks for up to 20 minutes; the printed origin, workspace, provider and model describe only that synthetic fixture. Interrupt the qualifier to stop both processes. The fixture password/key are intentionally synthetic and must never be reused for deployment. Production tests must use a separately provisioned key and approved hosting.
