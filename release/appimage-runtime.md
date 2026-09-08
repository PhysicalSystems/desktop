# AppImage runtime and portable replacement

The intended supported AppImage mode executes the **original, SHA-256-anchored
artifact** with `--appimage-extract-and-run`. It requires an explicit,
application-specific AppArmor prerequisite on Ubuntu. It does not establish
normal double-click/FUSE startup on stock Ubuntu. The `.deb` remains the normal
Linux download.

The helper code and inert tests alone are not native evidence. The packaged
qualification caller integrates the boundaries below; it must run them on
disposable GitHub-hosted Linux before emitting native probe results.
Existing extracted-`AppRun` smoke evidence cannot satisfy these runtime checks.

## Runtime behavior and ownership

Pinned electron-builder 26.15.2 defaults to its legacy AppImage toolset 0.0.0,
which uses AppImageKit runtime `effcebc`. Its
[pinned runtime implementation](https://github.com/AppImage/AppImageKit/blob/effcebc/src/runtime.c#L661)
hashes the entire original artifact with MD5 solely to name
`TMPDIR/appimage_extracted_<digest>`, extracts there, forks the contained `AppRun`,
waits for it and removes the extraction. SHA-256 remains the trust anchor. This
mode requires no FUSE mount and is a supported runtime option, not a renamed
extracted launcher.

`prepareAppImageRuntime` validates the owned executable artifact, the known
runtime shape and the exclusive, short, mode-0700 temporary directory. It supplies
an exact executable path and exact AppArmor `userns` profile, with no wildcard or
global policy modification. The caller must load and later remove this specific
profile using the existing disposable-runner checks. A Debian installation must
not stand in for this independent AppImage prerequisite.

Before every actual runtime launch, the helper requires unchanged artifact bytes
and an absent extraction cache. The original runtime is launched with its option
prepended to ordinary qualification arguments and the same owned TMPDIR. Its PID
is **not** Electron's PID: the runtime forks and waits. Before accepting the
private Electron attachment, the caller must supply actual `/proc` observations
to `bindAppImageElectron`: the runtime's exact executable, one direct child with
the same UID and expected executable path, and the actual extracted executable
and resources matching the independently measured payload fingerprint. All
attachment, CDP, application cleanup and descendant checks continue to apply.

After shutdown, both runtime and Electron/descendants must have exited, the
runtime must return zero, and its extraction cache must actually be absent.
`afterShutdown` only observes these conditions; it never deletes a retained cache
to turn failed runtime cleanup into a success. An uncertain process boundary
retains the application-specific policy and temporary directories.

## Portable reinstall scope

After the three credential processes have fully stopped and the runtime cache is
gone, `qualifyAppImageReinstall` removes only the owned AppImage executable file
and copies the same anchored artifact back. It preserves the profile. A fourth
real runtime launch must bind the actual new Electron process and payload, read
the persisted conversation, transcript, completed three-trial experiment and
deliberately saved pinch-zoom preference, then stop without sending another prompt
or replaying a trial. The helper compares the existing `ReinstallObservation`
shape against its frozen baseline and requires confirmed runtime/app cleanup.

This is portable-file replacement, not package-manager installation, OS desktop
registration, upgrade or a default-profile test. Those limitations stay explicit
in its result. Any failed or uncertain boundary remains failed; native receipt
generation and publication do not infer missing checks.

## Download and release wording

Use “Linux (.deb)” for the normal Linux download. Label the AppImage option
“AppImage — advanced: extract-and-run with AppArmor setup.” Explain that a download
alone does not configure this Ubuntu prerequisite. Do not describe the mode as
one-click, stock-Ubuntu, FUSE-tested or Wayland-tested until separate real evidence
supports those claims. No global sandbox-disabling instructions are appropriate.
