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
