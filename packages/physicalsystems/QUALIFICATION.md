# Local integration qualification — 7 September 2026

This is an unpacked development review candidate, version `0.0.0-physical-review.1`. It is not a published release, an installer, or a claim of robot readiness. The independent release task owns CI, signing, installer/update qualification and publication.

## Recorded inputs

- OpenCode baseline: `57ef3828431790c53f8f333c7ffbfe88770a1812`.
- Canonical public operator source: clean `c68eb84904342e73d9dcd96253b78e22f8643b1e` (including `ba313a5`). The vendor manifest records 28 source hashes and seven artifact hashes.
- Toolchain: Bun 1.3.14, Electron 42.3.3, Node.js 22.19.0 for external test orchestration; dependency versions are fixed by `bun.lock`.
- Test host: Ubuntu 22.04.5 LTS, Linux x64. Electron input was automated through CDP on X11/Xwayland. This does not constitute manual usability or optical display measurement.
- The model catalog was saved from models.dev as an explicit build input. It contains provider/model metadata, not model weights or configured accounts.
- Review source is frozen separately from concurrent cloud integration. Cloud changes and release-pipeline work are excluded from this candidate; their original working files are preserved.

## Automated evidence

| Check | Result | Scope |
| --- | --- | --- |
| Canonical `npm test` | PASS: 890 passed, 14 explicit skips | Public source/legal/boundary, CLI, legacy desktop and 22 operator tests; skips are not passes. |
| Integration library `bun test src` | PASS: 46 tests | Transport bounds/cancellation, credential abstraction, continuation admission, attachments, migration, lifecycle and transactional artifact replacement. |
| Actual adapter tests | PASS: 11 tests | Actual manifest-verified operator catalog, trusted scope, tool ceiling and upstream auxiliary prompts. |
| UI state/conversation/locale tests | PASS: 17 tests | Exact state/digest/owner checks, preprompt session binding, locale coverage. |
| Actual Solid browser fixture | PASS: 58 assertions | Fake IPC, real JPEG decoding, hover/focus/pin/navigation, inline approval, pending deduplication, Stop above the connection gate, recovery and inert imported history. |
| Type checks | PASS | Package-local operator library, app/desktop and complete OpenCode backend. |
| Desktop production build | PASS | Immutable public operator bundle, prebuilt OpenCode server, preload and renderer. |
| Linux unpacked packaging | PASS | Distinct review identity; required server, worker, skills, provenance and MIT/Apache notices present. |

Counts above describe distinct suites and assertions; do not add assertions to test counts. The backend type check used the same backend source as the frozen snapshot. Final app/desktop, library and focused adapter checks used the frozen review worktree.

## User journeys

| Journey | Result | Evidence and limit |
| --- | --- | --- |
| New project → conversation → device panel | PASS, simulation/fakes | An empty owned session is created and bound before the first prompt. Hover and View devices do not connect or discover equipment. Counts distinguish detection/preview activity from motion readiness. |
| Discovery → capabilities → planning → proposal | PASS, fakes | Canonical service integration exercises supported routing and missing-setup explanations. No live discovery or Avahi probe was performed here. |
| Chat proposal → exact inline approval → measurements → result | PASS, deterministic provider | Real Electron/OpenCode/adapter/service path completed three arithmetic trials. Approval remains outside the agent tool interface. The observed fixture result was 3 mm baseline error, then two 0 mm measurements at 3 mm offset. |
| `/model` picker | PASS, packaged Electron | The slash command opened the inherited model/provider picker without submitting a model prompt. No real account was connected. |
| Reload and shared command-line conversation | PASS, deterministic provider | Reload restored the visible transcript and three trials without replay. Actual `opencode run --attach` posted one exact message to the same server/session; the desktop displayed it. This does not qualify the interactive terminal UI or legacy Pi history as the same session. |
| Shared question/answer and cancellation | PASS, deterministic provider | Another attached client submitted a question, the desktop displayed it, one answer settled it, a duplicate was rejected, and cancellation returned the shared session to idle without another trial. |
| Camera lifecycle | PASS, synthetic frames | Slow/failed replacements retain the previous valid image until its original expiry. Pixels/frame identity swap together; expiry, Stop, disconnect, selected camera/capture and conversation changes clear pixels. Held/late decodes cannot block or revive another owner. |
| Execution preparation/approval/dispatch/Stop/receipts | PASS, fake Node | Exact ownership and independent background Stop verified. Simulation receipts do not establish physical success. |
| Recovery and shutdown | PASS, bounded automated scope | Service identity changes require explicit recovery; stale additional windows can resynchronize. Pending operations and cleanup retain ownership; last-window close and startup shutdown wait for confirmed cleanup/process exit. Real server/worker fault injection and full app relaunch remain separately unqualified. |
| Migration | PASS, temporary fixtures | Explicit copy-only imports preserve originals, sanitize/inertly display history, retain draft/branch references and never import approval authority. |
| Real provider API-key/OAuth/native vault | NOT TESTED | No real credentials or provider inference were used. Encryption abstraction/refusal and cancellation/error paths have automated coverage; OS vault and real sign-in still require qualification. |
| Live camera, SO-101, commissioning or robot motion | NOT TESTED | Device access is disabled in the review launcher and packaged review app. No physical experimentation or learned/VLA policy was implemented by this migration. |
| Windows, native Wayland, installers and updates | NOT TESTED | X11/Xwayland results do not establish these targets. No installer, upgrade, publication or running-installation change occurred. |

**Headless UI blanking passed; optical/display flicker was not measured.**

## Reproductions fixed in this integration

The tests caught an actual catalog schema mismatch (`label`), auxiliary prompt replacement, pre-arrival cancellation and repeated gateway-close behavior, managed workspace symlink redirection, continuation retry/ownership gaps, pending shutdown/startup ownership, stale artifact reuse, a held camera decode blocking a new capture that reused a frame ID, and generic workspace CSS exposing OpenCode's hidden composer file input. Relevant failing-before logs are retained with the passing-after results.

Early native harness failures also included incorrect selectors, pointer/scroll timing and OpenCode CLI positional-argument quoting. These were corrected in the test harness; they are not product defects or passing runs. Native diagnostics and fixture transcripts are local evidence only.

## Remaining release blockers and follow-ups

1. Qualify the intended Windows/Linux installer targets, native credential storage, at least one actual API-key and OAuth flow, and installed relaunch/update/rollback. The independent release pipeline should consume the recorded source and tested bytes, not mutable local output.
2. Exercise real model-server/operator-worker death and full app relaunch on each supported platform, including unknown operation outcomes. The implementation has bounded ownership/recovery contracts; helper/browser tests alone are not full native fault qualification.
3. A lost physical Start/Prepare acknowledgement with no operation ID remains BLOCKED for automatic reconciliation. The service retains ownership and does not guess an ID or claim confirmed Stop. A separate Node request-identity/reconciliation contract is required to automate this case.
4. Keep the Avahi partial-results defect as a separate Node follow-up. Learned policies, physical autonomous experimentation and SO-101 qualification remain separate capabilities.

The companion local handoff records the final fork commit, model-catalog and lockfile hashes, packaged artifact hashes, native test directories and commands. Evidence, runtime attachment credentials, vault files and camera imagery are excluded from the repository.
