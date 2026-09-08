# Packaged software display qualification

`native-platform-display-probe` runs once in the actual packaged application,
after its real project, conversation, model and composer are ready. It requires
a disposable GitHub-hosted runner and the caller's verified renderer CDP target.
Local unit tests use fake protocol responses and fixture pixels; they provide no
native display evidence.

The supported software scope is the Windows hosted runner's desktop session and
Linux X11 under Xvfb. Launch arguments use the application's default graphics
selection: no forced GPU disabling, software renderer, headless mode or Ozone
backend. This does not establish hardware GPU acceleration. Existing renderer
sandbox and process-ownership checks remain required separately.

The probe:

1. Requires one visible, editable, empty real composer and records its viewport,
   outer window geometry, active element, native zoom and fullscreen state.
2. Brings the owned page forward, clicks that composer using protocol pointer
   events and confirms both DOM focus and Electron's native window focus.
3. Captures the actual composer compositor surface, types one fixed inert line
   without submitting, captures again and verifies substantial nonuniform paint
   changes. A uniform surface, unchanged capture or single blinking caret fails.
4. Clears the text using actual Ctrl+A and Backspace keyboard events, changes
   zoom through the existing desktop API, observes real viewport reflow and
   repeats the compositor paint check.
5. Restores the empty draft, exact original zoom and original focused DOM element,
   and confirms unchanged outer geometry and fullscreen state. Restoration
   uncertainty fails the probe. Mutating protocol calls are never retried.

PNG captures remain in memory. An unattached `OffscreenCanvas` decodes the actual
captures for pixel comparison; it does not draw a replacement widget or overlay.
Receipts contain fixed scope/boolean fields and bounded pixel counts only, with
no screenshots, user content or model requests. The enclosing qualification must
still confirm application and descendant shutdown before this evidence is usable.

Native arbitrary window resizing, Wayland, physical monitor output, hardware GPU
behavior and optical flicker are explicitly unmeasured. They are not inferred
from Xvfb or compositor pixels. Electron 42.3.3 does not implement Chrome's
`Browser.setWindowBounds`/`getWindowForTarget` CDP controls; its
[pinned DevTools delegate](https://github.com/electron/electron/blob/v42.3.3/shell/browser/ui/devtools_manager_delegate.cc#L104)
handles only `Browser.close`. The probe therefore exercises the existing product
zoom API and reports `arbitraryNativeResizeTested: false`.

`Page.captureScreenshot` uses the documented compositor-surface option, and
pointer/keyboard events use the real renderer protocol handlers. See the primary
[Page protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot)
and [Input protocol](https://chromedevtools.github.io/devtools-protocol/tot/Input/).

## Package launcher scope

An installed Debian package exercises its shipped application-specific AppArmor
policy. The AppImage controller executes the exact original artifact with the
documented `--appimage-extract-and-run` option, after setting up a runner profile
scoped to its exact extraction path. It separately verifies the actual Electron
child, payload and runtime cleanup; see [the runtime scope](appimage-runtime.md).
These new checks still require actual native CI evidence. Historical extracted
`AppRun` results do not establish original-runtime startup.

Display evidence under this explicit Ubuntu prerequisite does not establish
stock Ubuntu double-click/FUSE startup. The display probe cannot independently
satisfy the fresh AppImage runtime check.
