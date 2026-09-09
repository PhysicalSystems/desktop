# Public installation upgrade lab

The public producer freezes two separately versioned public builds from its exact
reviewed source and signing policy. The lower preview is an **unreleased lab
baseline**; the strictly newer target is the only version eligible for public
collection. Both complete release/public input digests and the upgrade-plan digest
come from the trusted preparation job, before signing credentials or native
installation. Both builds compile their own exact version; neither relabels an
existing candidate or installer.

For the first preview with empty release history, the lab uses `0.1.0-beta.1` and
the target uses `0.1.0-beta.2`. Later preparation allocates both above the complete
public release history, including drafts. The lab version is recorded in this
run's target allocation history and uploaded under a separate `desktop-upgrade-lab`
artifact name. It never appears in the target inventory or qualified publisher
bundle. A previously published release is not required to bootstrap the lab.

This tests installer replacement and preservation **within the same reviewed
source and storage schema**. It does not test historical database migrations,
candidate-to-public migration, every possible user file, or a physical power loss.

## Native sequence

The existing target simulation, actual V2 encrypted credential storage/restarts,
and same-byte reinstall finish first, with confirmed application and descendant
shutdown. The lab then uses a separate initially empty owned profile. A lower
public build creates one inert conversation, three completed synthetic trials,
a deliberately toggled pinch-zoom preference and an encrypted canary credential.
The lab's provider instance, state and checks remain separate from target evidence.

The normal upgrade installs the exact target over this baseline, verifies its
compiled public identity and executable/resources fingerprint, launches the target
with the same lab profile and reads the preserved state. These read-only relaunches
do not submit a model prompt or repeat a trial. Conversation/session ownership,
transcript and trial hashes, the toggled preference, and encrypted-vault bytes
must match. The original target profile is independently reopened read-only after
each lab sequence and must also retain its original state and vault hash.

Recovery restores the same verified lower lab installation after confirmed target
shutdown. Its originally baseline-seeded profile must still match before the
second sequence. The interruption and recovery observations are format-specific:

- **Windows NSIS:** both baseline and target installers and payload executables
  must match the pinned public signing policy, including actual unsigned
  observations for an explicitly selected unsigned preview. After observing the
  old ASAR disappear, the controller can interrupt only its owned live installer
  tree when it observes partial target bytes or a new nonempty busy destination.
  A busy file is only a one-shot stop trigger. After confirmed installer and
  observed descendant exits, the real byte observer must prove partial target
  ASAR content for either trigger path, and the full payload must differ from
  both complete versions before reinstalling the exact target. Expensive process
  enumeration runs independently of the watcher. Complete, unchanged, missing,
  empty or unreadable post-stop content remains unconfirmed; there is no timing
  hook, altered installer, fabricated interruption or blind retry. Fixed failure
  checkpoints record observation progress without paths or file contents.
- **Debian:** the exact target performs `dpkg --unpack`. The native package database
  must show the exact public package/version as `install ok unpacked`, and its
  executable/resources must match the target. The controlled interruption is
  before package configuration. Recovery runs the exact target installation to
  completion and verifies `install ok installed` plus the actual relaunch.
- **AppImage:** the real target prefix is written and synced into a private
  exclusive staging file, then the writer closes before atomic replacement.
  The baseline artifact remains byte-identical and is actually relaunched to
  prove preserved usability. Recovery audits the owned partial file, writes and
  syncs the exact complete target, atomically replaces the portable artifact and
  syncs its directory. The exact runtime/AppArmor path is recomputed for each
  artifact before native launch. This tests portable file replacement, not a
  system installer, FUSE, stock Ubuntu double-click or a physical display.

Any uncertain installer, child, temporary directory, AppImage extraction cache or
sandbox-policy owner retains its state and prevents another format or inverse
cleanup operation. A timeout or rejected download does not qualify as recovery.

Only actual successful native runs author `native-upgrade-probe` and
`native-failed-upgrade-recovery-probe`. Local tests use inert files and fake
processes; they establish controller ordering and rejection behavior only.
