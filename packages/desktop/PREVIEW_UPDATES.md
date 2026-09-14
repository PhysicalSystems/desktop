# Preview installer updates

Public packaged beta releases expose **Update** in the top-right title bar and
Settings on Windows x64 (installed NSIS package) and Ubuntu x64 (installed
`physical-systems-desktop` Debian package). The button checks the public website's
selected release, downloads the matching installer, asks for confirmation, and
hands installation to the operating system after owned services have stopped.
There is no automatic download or install on quit. Versions without this feature
need one manual installer upgrade before the button becomes available.

The preview path is separate from the disabled signed `electron-updater` policy.
It accepts only a newer public preview selection marked as an unsigned Windows
preview. Stable releases, candidates, development builds, AppImages, macOS and
other architectures do not use it. Windows may warn or block an unsigned
installer. Ubuntu asks for system authorization through Polkit.

## Release and installation boundaries

- Discovery validates the complete selected release against anonymous GitHub
  release metadata, including exact tag, publication, installer names, sizes and
  SHA-256 digests. It refuses downgrades and unselected releases.
- Downloads use a private cache, bounded HTTPS requests and allowlisted GitHub
  asset redirects. Full bytes are verified before reuse and again before native
  installation. This verifies consistency with the official HTTPS sources; it
  does not constitute a publisher signature or independent signing authority.
- Windows launches the original interactive NSIS installer without a shell or
  silent-install arguments. A successful spawn means handoff, not installation
  completion. The installer controls reopening the application.
- Ubuntu verifies native package ownership and invokes fixed system
  `pkexec dpkg --refuse-downgrade --install` arguments. Success requires the
  expected package version and installed status before relaunch. There is no
  automatic dependency repair, downgrade or package-manager lock removal.
- Confirmation defaults to Later. Failed operator cleanup prevents installation.
  Async native handoff reserves lifecycle shutdown, preventing a competing quit
  or relaunch while an installation is unresolved.

## Interrupted installation

A main-only journal records source version, target version and installer digest;
it never stores executable authority or triggers a retry. Renderer storage IPC is
confined to flat names outside the journal's directory. Startup acknowledges an
attempt only from an actually running supported target or newer version.

**Check installation** is an explicit, read-only recovery operation. Ubuntu can
recognize a completed target or the unchanged original package, after confirming
package-manager inactivity with an unrestricted process view and rechecking
package identity. A completed target goes through owned-service cleanup before
relaunch. An unchanged original package allows a new check and verified download.
Uncertain observations keep the attempt blocked.

On Windows, disappearance of the original NSIS process is insufficient: its
uninstaller child can survive it. Until the supported updated application runs,
an uncertain attempt remains blocked and may require completing the official
installer manually. Neither platform kills a potentially active installer during
recovery.

## Validation and remaining release qualification

CI runs discovery, filesystem download verification, controller, recovery and
inert native-process tests on Windows and Ubuntu. A rendered component fixture
exercises the actual shared titlebar button and update action, including
confirmation cancellation and failure states. These tests do not invoke a real
NSIS installer or privileged package installation.

Before publishing a release with this feature, verify an installed previous
public version containing the button through download, native authorization,
installation, restart, journal acknowledgement and retained user data on both
platforms. Exercise native cancellation and interrupted-installation recovery.
The current unsigned preview is not signed-updater qualification, and the
existing stable updater gate stays disabled.

## Disposable native updater test

The manual **Desktop source checks** workflow has a `preview_updater_test` option
for Windows 2025 and Ubuntu 24.04 hosted runners. Supply `updater_test_history` as
the complete desktop version history, including drafts, in the form
`{"complete":true,"versions":["0.1.0-beta.7","0.1.0-beta.6","0.1.0-beta.4","0.1.0-beta.2"]}`.
Read the current release history before dispatching; this example is not an
authoritative history snapshot.

This builds the selected committed source as an explicitly unpublished
`0.1.0-beta.1` fixture. The lower version allows the new updater to discover the
existing public release through its unchanged production HTTPS flow. Both baseline
input records carry the test purpose, and public production, qualification and
collection reject it. The workflow does not reserve a release, publish an
installer, change the website, or alter the public version sequence.

The same clean source and complete history also produce a separate private
startup-acknowledgement fixture through ordinary next-version allocation, such as
`0.1.0-beta.8` after beta.7. Its version is derived from the supplied history, not
hardcoded or reserved. It uses normal public build inputs with publication
disabled and remains inside the disposable runner; no producer, qualification,
collection or publication command consumes it.

On each fresh runner, the test installs the fixture once, opens its actual
titlebar Update button, checks the verified download, chooses **Later** in the
real native dialog, then confirms installation. Windows uses the original
interactive NSIS installer and observes its actual restarted process. Ubuntu
uses the application's real `pkexec dpkg` request and authenticates through an
owned Polkit agent with a temporary runner account. Neither test replaces the
update feed, bypasses the application confirmation, or manually launches the
target to manufacture restart evidence.

Native confirmation automation stays bound to the owned app process and exact
version question. Windows verifies the real command-link controls when its
accessibility provider does not expose them as ordinary buttons. Ubuntu first
uses AT-SPI; for GTK dialogs absent from that tree, it recognizes the exact public
question and button labels in the app-owned X11 window before sending events only
to that window. Neither path uses global keyboard or pointer input.

Source CI first exercises the native controls in small owned Windows and Ubuntu
fixtures. The Ubuntu fixture uses the pinned npm Electron engine with an empty
offline window and no app backend, profile credentials, or installer. Its
explicit `--no-sandbox` flag is confined to that inert engine; it does not test
production sandboxing or alter the packaged application's launch arguments.

After observing that public target close normally, a separate manual phase checks
the exact attempt journal left by the real update. It installs the private newer
fixture, verifies that installation preserved the journal, and explicitly launches
the new code on the same profile. The test then observes automatic startup
acknowledgement clearing that attempt and verifies the retained setting. It does
not call Check installation or force another update check to clear the journal.
This phase proves manual-install startup acknowledgement; it does not claim an
in-app update to the private newer version or interrupted-installation recovery.

The retained `result.json` identifies exact source, versions, installer hashes,
completed stages and a fixed failure code. It verifies one preserved renderer
setting and normal target closure, and reports the manual startup acknowledgement
separately from the actual in-app update. It is separate from release
qualification: the current beta.7 target predates the new journal acknowledgement
code, and the test does not exercise native interrupted-installation recovery or
complete conversation/credential migration. Ubuntu can also retain the two
app-owned confirmation images after exact public-text verification. A recognition
failure may retain the exact owned `Update Ready` window for diagnosis after
process, title, window-type and visibility checks. These captures happen before
authentication and never capture the desktop. Profiles, passwords, packages,
arbitrary screenshots and raw app logs are not uploaded.
