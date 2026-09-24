# Full LeLab setup inside PhysicalSystems

This is a proposed integration, not an implemented calibration feature. The
camera adapter in this change displays existing LeLab camera configurations; it
does not calibrate motors, command movement, or embed the LeLab wizard. A full
guided setup is the intended end state, with LeLab retaining its calibration
implementation and PhysicalSystems coordinating device ownership and navigation.

## Operator workflow

1. Connect to a compatible LeLab service and select an existing robot record.
   Keep that explicit selection through setup; never substitute another robot
   when a saved selection disappears.
2. Show the record's leader and follower ports separately, together with their
   saved calibration files. Reuse existing calibration when it matches the
   selected hardware. Opening setup must not start calibration or rewrite files.
3. Show the saved joint ranges and offsets, their source, and whether they have
   been checked against the selected device. File presence alone is not proof
   of a valid calibration. Explain which side, if any, needs calibration.
4. For an explicit new calibration or replacement, obtain exclusive ownership
   of that side's serial device, then run LeLab's existing homing and manual
   range-recording workflow. Preserve the other side's calibration. Report
   completion only after the device writes and file save succeed.
5. Load the robot's saved cameras, names, stable device paths, and capture
   settings. Let the operator check overview and wrist images. Camera preview
   does not establish camera-to-robot geometry or motor calibration.
6. Present the resulting setup and any unresolved checks before offering a
   separate teleoperation or recording action. Calibration completion must not
   automatically enable motion.

## Reuse boundary

LeLab uses React; this app uses Solid. Embedding its existing wizard preserves
the workflow with less duplicated state and maintenance than porting the full
React page to Solid. A native Solid port remains possible but would require
reimplementing selection, polling, cancellation, progress, persistence, and
error handling against the same Python service; it does not remove the backend
ownership problems below.

The existing production page is `http://localhost:8000/calibration`, defined in
LeLab's `frontend/src/App.tsx`. Its server supplies SPA navigation fallback.
However, `frontend/src/pages/Calibration.tsx` currently gets `robot_name` only
from React navigation state supplied by the landing-page gear icon. A direct
iframe URL has no robot selected. Add a supported, validated selected-robot
deep link or embedded route instead of manipulating React history internals.

No framing-blocking CSP or X-Frame-Options is configured in the inspected LeLab
source. This does not establish compatibility with the desktop's CSP or verify
runtime framing. Load LeLab at its own allowed loopback origin so root-relative
assets work; do not grant it desktop Node or privileged preload capabilities.
Any parent/child messages need exact origin and source validation. An embedded
mode should keep navigation within setup rather than expose unrelated controls.

## Requirements before exposing full calibration

- **Exclusive device ownership:** `lelab/calibrate.py` checks only its own active
  calibration flag. It does not coordinate with LeLab teleoperation, recording,
  inference, or PhysicalSystems Node. Introduce a mutually enforced device
  handoff/lease across those owners, with refusal while another owner is active.
  Disabling a button or relying on LeLab's browser BroadcastChannel is not a
  cross-process lock.
- **Early writes and cancellation:** Start connects to the device, disables
  torque, resets calibration, and writes homing offsets before the final save.
  Completion writes the calibration and saves its JSON. Existing cancellation
  does not restore the previous offsets. Preserve a backup before explicit
  replacement and define how interrupted/partial calibration is reported and
  recovered; do not describe Cancel as an automatic rollback.
- **Guarded closing:** the React page sends Stop on component unmount, but iframe
  destruction or window closure cannot be assumed to deliver that cleanup.
  Preserve the frame during active work, warn before leaving, request an
  explicit stop, and verify termination/device release before teardown or
  handback. Backend stop currently joins for five seconds and can report cleanup
  after that timeout; a positive release acknowledgment needs stronger semantics.
- **Status:** expose selected robot, selected side, phase, and ownership without
  starting work. Existing `GET /calibration-status` reads motor positions during
  range recording; a purely cached parent status needs a separate bridge or
  metadata endpoint. Handle reconnects without silently restarting calibration.
- **Saved data:** retain existing calibration unless replacement is explicitly
  chosen. Version/check the device identity and record before saving; a stale
  selection must not write calibration for a different robot.

## Read-only 3D visualization

The yellow SO101 view is separate from calibration:
`frontend/src/components/UrdfViewer.tsx` wraps `urdf-loader`'s custom element and
Three.js, while `useRealTimeJoints.ts` feeds joint values. It can be reused as a
display adapter independently of the wizard. In the inspected implementation,
the live badge follows websocket connection rather than fresh position data;
missing/read-failed joints can become zeros and gripper normalization is only an
approximation. A PhysicalSystems view must label disconnected/stale/unknown data,
carry measurement time and robot identity, and avoid showing zero as a valid
measurement on failure. Dragging a virtual joint must never imply a motor command.
The generic mesh is not a collision model or proof of safe physical clearance.

## Acceptance checks for the future implementation

- Opening/reopening setup makes no calibration writes; valid existing leader
  and follower files remain unchanged. Missing/deleted/changed robot selections
  never fall back to another device.
- Calibration cannot start while any coordinated owner holds the selected
  serial device, including races between Start requests. Other robot sides keep
  their saved data. Interrupted calibration has an explicit recovery state.
- Back, project switch, iframe reload, window close, service failure, and stop
  timeout cannot leave an unnoticed active owner or falsely report release.
- Camera names, paths, and settings survive setup unchanged unless explicitly
  edited. Preview activation never starts calibration or motion.
- Framing, storage, selected-robot deep links, origin validation, and loss of
  the service work in the packaged desktop. Joint displays reject stale,
  malformed, missing, and wrong-robot samples without inventing positions.

## Provenance

LeLab's root/frontend license is Apache-2.0; retain its attribution and notices
when copying code. `urdf-loader` is Apache-2.0 and Three.js is MIT. LeLab's SO101
assets credit TheRobotStudio's SO-ARM100 repository (Apache-2.0 upstream), while
the bundled URDF package metadata includes a BSD license tag. Check and preserve
the exact mesh/URDF provenance and notices when vendoring them; the application
license alone does not resolve that metadata discrepancy. The upstream model
also documents a gripper-normalization mismatch, so reuse must keep the
visualization's accuracy limits explicit.
