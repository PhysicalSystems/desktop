# LeLab cameras in chat

The desktop chat has a Cameras switch above the conversation. On connects to a
running LeLab service, loads its configured robots and displays their attached
camera previews. One configured robot is selected automatically on first use;
multiple robots require a selection. Names, device identities and capture settings
come from LeLab. A previously selected robot that disappears is not replaced silently.

## Connection

- Start the existing LeLab installation on the computer connected to the cameras.
- In the desktop chat, turn Cameras on and expand **LeLab connection** if needed.
- For LeLab on the same computer use `http://127.0.0.1:8000`.
- For LeLab on another computer, use an SSH local port forward and enter that
  loopback address (for example `http://127.0.0.1:18080`). The app does not create
  this additional tunnel automatically. A Node connection alone is not a LeLab tunnel.
- Select the robot whose saved camera configuration should be used.

This version requires the Linux backend-preview API from our LeLab camera fix:
`GET /robots` and `GET /camera-preview`. It supports configured OpenCV cameras with
explicit Linux device paths; browser-only and RealSense previews are reported as
unsupported. The local fix is preserved in
[the LeLab fork](https://github.com/lienertdemaeyer/leLab/tree/fix/linux-camera-identity),
with upstream discussion in [LeLab issue 119](https://github.com/huggingface/leLab/issues/119).
An unmodified LeLab installation without these endpoints is not supported by this adapter.

## Ownership and privacy

LeLab remains the camera owner. The desktop requests JPEG previews using the exact
saved capture settings, sharing LeLab's workers and respecting its busy responses
during recording/inference. A configuration change invalidates the current preview
until the operator refreshes. The app never falls back to a different device index.

Off cancels this window's HTTP requests and clears its images. It does not send a
global stop, close another viewer's capture or stop recording. LeLab retires an idle
preview worker after its own idle timeout (currently five seconds); other viewers
may keep it active. Changing projects/conversations or closing the window also
cancels this preview generation. Invalid, failed and stale images are cleared.

Previews are transient UI content. They are not chat messages, recordings, model
inputs or training data, and turning them on makes no model/API upload. This feature
does not command the robot, modify camera configuration, or change calibration.

## Implementation

- `packages/physicalsystems/src/lelab.ts`: a bounded, loopback-only HTTP adapter.
- `packages/desktop/src/main/ipc.ts`: trusted main-frame IPC and window-owned cancellation.
- `packages/app/src/physicalsystems/lelab-preview.ts`: preview generation and polling.
- `packages/app/src/physicalsystems/lelab-cameras.tsx`: Solid camera controls and decoded image display.

The API behavior and interaction design reuse LeLab's camera work. LeLab's React UI
and Python capture code are not copied into the desktop; our Solid UI consumes its
existing service. LeLab is Apache-2.0 licensed. For the separate calibration and
robot visualization integration, see `lelab-calibration-integration.md`.

## Validation

Tests use isolated HTTP servers and synthetic JPEG images; they do not open USB,
serial ports or motor power. They cover configured camera identity, changed config,
busy and malformed responses, loopback and redirect restrictions, response limits,
cancellation races and cross-conversation frame isolation. Browser tests exercise
the actual Solid camera component. A live preview check still requires a running
compatible LeLab service and the intended cameras.

Verified locally on 2026-09-24: 15 HTTP-adapter tests (80 assertions), four preview
controller tests plus nine existing state tests (45 assertions), and the camera
browser scenario (35 assertions) passed. App, desktop and physicalsystems package
typechecks and the complete app production build passed. Five baseline and five
after-change production UI runs each passed the existing 73-assertion scenario,
with no measured timing regression in that isolated fixture. This does not measure
packaged desktop startup or live camera latency. LeLab was not running during the
final check, so live integration and packaged desktop verification remain pending.
