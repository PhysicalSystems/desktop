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

## Advanced user setup

Use the `.deb` if you want the normal package installation. The steps below are
for an administrator configuring the same narrow AppArmor prerequisite used by
the AppImage qualification path. There is no shipped one-click setup script.

1. Verify the downloaded AppImage's SHA-256 against the release notes. Keep the
   original file and make it executable with `chmod +x <downloaded-file>.AppImage`.
2. Create a short private temporary directory, for example
   `ps_appimage_tmp=$(mktemp -d /tmp/ps-appimage.XXXXXX)`. `mktemp` gives it mode
   `0700`; keep that path for this launch. Compute `md5sum <downloaded-file>.AppImage`.
   The MD5 is only the pinned runtime's extraction-directory name, not a trust check.
3. Resolve the exact extraction executable path as
   `<private-directory>/appimage_extracted_<whole-file-md5>/physical-systems-desktop`.
   An administrator must load an AppArmor profile for that **literal** path before
   launching. Replace both placeholders in this profile; do not use wildcards:

   ```text
   abi <abi/4.0>,
   profile "physicalsystems-appimage-<unique-name>" "<exact-extraction-executable>" flags=(unconfined) {
     userns,
   }
   ```

   Save this as a dedicated profile file and load it with
   `sudo apparmor_parser --add --skip-cache <profile-file>`. It grants user
   namespaces to this one executable path. It does not disable the application's
   renderer sandbox or change the global user-namespace policy.

4. Run the verified original artifact in a terminal with the same directory:

   ```sh
   TMPDIR="$ps_appimage_tmp" ./<downloaded-file>.AppImage --appimage-extract-and-run
   ```

   Keep the terminal open until the app exits. A different artifact or temporary
   directory needs a newly resolved exact profile path; the previous permission
   is not reusable for an arbitrary executable.

5. After closing the app and confirming that the runtime command returned
   successfully, remove the dedicated profile with
   `sudo apparmor_parser --remove --skip-cache <profile-file>`, then remove that
   profile file and the downloaded portable file if no longer needed. The
   runtime should remove its own extraction cache. `rmdir -- "$ps_appimage_tmp"`
   removes only an empty private directory; retain a nonempty directory when
   runtime cleanup is unconfirmed instead of forcing its deletion.

The application profile, including conversations and credentials, is separate
from the portable executable and extraction directory. These instructions do
not delete it. The tested setup covers Ubuntu 24.04 X11/Xvfb extract-and-run;
Wayland, stock Ubuntu double-click and FUSE startup remain outside this evidence.

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

## Portable upgrade and interrupted replacement

`prepareAppImageReplacement` supplies actual file operations to the common public
upgrade controller. The controller independently anchors the older lab build,
target build, source/input digests, payloads, vault and persisted state using the
existing public upgrade plan. The file helper does not create a second receipt or
plan format and never launches an application.

For a normal replacement it writes the full anchored target to an exclusive
`appimage-upgrade.incoming` file beside the owned runnable. It synchronizes and
hashes that file, rechecks the unchanged baseline and source, atomically renames
the target over the runnable, synchronizes the directory and verifies the final
bytes. All application/descendant processes and runtime extraction must be gone
before these operations.

The controlled interruption stops after a bounded target prefix is written and
synchronized to the staging file. All writer descriptors are closed; the baseline
runnable remains byte-identical. The actual native controller must demonstrate
that the baseline still launches with unchanged payload, vault and profile before
continuing recovery. Recovery accepts only the remembered partial file's exact
inode, size and hash, replaces that partial stage with the complete target, and
performs the normal atomic replacement. A changed or unrecognized partial file
is retained and fails qualification.

The target's artifact MD5 changes its runtime extraction path. Before its real
launch the controller must prepare its corresponding exact AppArmor profile and
bind the actual target Electron process/payload again. Prior profile permissions
and temporary directories may be removed only after their owned process cleanup
is confirmed. The target's actual read-only launch must preserve the baseline
conversation, completed experiment, transcript, preference and vault evidence.

This scope is “interrupted portable staging before atomic replacement.” It is
not an installer-process interruption, package-manager recovery or power-loss
test. The helper's real inert-file tests do not establish native application
recovery; those later controller observations remain required.

## Download and release wording

Use “Linux (.deb)” for the normal Linux download. Label the AppImage option
“AppImage — advanced: extract-and-run with AppArmor setup.” Explain that a download
alone does not configure this Ubuntu prerequisite. Do not describe the mode as
one-click, stock-Ubuntu, FUSE-tested or Wayland-tested until separate real evidence
supports those claims. No global sandbox-disabling instructions are appropriate.
