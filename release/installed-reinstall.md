# Same-version installed package persistence probe

The packaged smoke runs `native-reinstall-probe` for Windows NSIS and Linux Debian
installers on disposable GitHub-hosted runners. AppImage is excluded because its
current smoke exercises an extracted launcher rather than a package installation.
The probe uses the exact installer already tested by the core synthetic journey
and native credential phases. It does not build another installer or repeat the
three-trial experiment.

Before the credential restarts, the controller deliberately changes the existing
native pinch-zoom preference and confirms the setter took effect. After those
restarts, it records the active project/session, completed experiment and three
trials, the transcript digest and the saved preference. This baseline is copied
before asynchronous installer callbacks can run.

The sequence then requires:

1. Confirmed exit of the owned application and observed descendants, with its
   private runtime attachment removed.
2. The original installer SHA-256 still matching, followed by one uninstall.
3. Verified removal of the Windows installation directory, or of the Debian
   package, its fixed installed paths and its AppArmor profile.
4. The original installer SHA-256 still matching again, followed by installation
   of those identical bytes at the same location. Debian must restore its own
   AppArmor profile; Windows must restore the same owned uninstaller bytes.
5. The existing installed executable/resources fingerprint matching the original
   extracted payload. This fingerprint does not include every top-level Electron
   library; the exact installer digest is checked separately.
6. A fourth process launched with the same owned profile. After normal readiness,
   attachment and device-isolation checks, this phase only reads the original
   conversation, trial evidence and preference. It sends no model prompt or trial
   command. All recorded state must match, then shutdown must again be confirmed.

An uninstall or install remains uncertain until its corresponding verification
finishes. Nonzero exits, timeouts, retained paths or changed payloads stop the
sequence; final cleanup does not retry or reverse an uncertain package mutation.
The existing per-command, request and application shutdown deadlines still apply.
The smoke retains its ten-minute overall bound.

Windows executes an exact copy of the owned uninstaller outside the installation
directory. Its final unquoted `_?=` argument prevents the usual temporary-child
handoff, so the awaited process is the actual uninstall. The installer likewise
uses final unquoted `/D=`. Direct spawn quotes only the validated executable's
`argv0` and enables verbatim arguments; no shell is involved. These conventions
follow the [NSIS command-line documentation](https://nsis.sourceforge.io/Docs/Chapter3.html)
and [uninstaller waiting guidance](https://nsis.sourceforge.io/Docs/AppendixD.html).
The `argv0` forwarding behavior is present in the pinned
[Bun 1.3.14 child-process implementation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/js/node/child_process.ts).

The receipt records fixed booleans only. This proves same-version reinstall
persistence for the tested custom installation/profile, after a confirmed clean
shutdown. It does not establish a default-profile migration, an older-version
upgrade, interrupted-upgrade recovery, browser provider sign-in or public release
qualification. The collector requires this auxiliary PASS for NSIS and Debian,
while retaining all eight separate public native requirements unchanged.

The helper's unit tests use inert files and fake lifecycle callbacks. They verify
ordering, immutable evidence, retained uncertainty, refusal of non-disposable
runners and NSIS argument construction. They do not run an installer, native app
or keyring, and their passing result is not native evidence. The added probe must
run on each actual candidate/public artifact before its receipt can claim PASS.
