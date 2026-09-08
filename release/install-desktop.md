# Install Physical Systems Desktop

Download the asset for your operating system from the release linked by the
Physical Systems website. Compare its SHA-256 with the checksum in that release's
notes before opening it. A release's installation guides are pinned to its exact
source revision.

## Windows x64

1. Open the downloaded `physical-systems-desktop-<version>-windows-x64.exe`.
2. Complete the installer, then open **Physical Systems** from Start.
3. To remove the application, open **Settings → Apps → Installed apps**, find
   **Physical Systems**, and choose **Uninstall**.

The installer uses a per-user installation. Application removal is separate from
deleting your personal conversations, settings and saved provider credentials.

## Ubuntu / Debian x64

Use the `.deb` as the normal Linux download. In a terminal in the download folder,
replace the filename below with the exact downloaded version:

```sh
sudo apt install ./physical-systems-desktop-<version>-linux-x64.deb
```

Open **Physical Systems** from the applications menu or run
`physical-systems-desktop`. The package installs its application-specific sandbox
policy through its package scripts. To remove the application:

```sh
sudo apt remove physical-systems-desktop
```

This removes the installed program; it does not request deletion of your personal
profile. The native qualification environment is Ubuntu 24.04 x64 with X11/Xvfb.
Other distributions and display sessions need their own compatibility evidence.

## AppImage: advanced setup

The AppImage requires an explicit Ubuntu AppArmor prerequisite and a private
extraction directory. It uses the original artifact's `--appimage-extract-and-run`
mode. It is not qualified as a double-click/FUSE download on stock Ubuntu.
Use the [advanced AppImage guide](appimage-runtime.md#advanced-user-setup), or use
the `.deb` package for the normal Linux installation.

## Scope of the preview

The qualification journey uses synthetic experiments with device access disabled.
It verifies desktop behavior and preservation within the documented lab scope;
it does not establish robot performance or authorize hardware movement. Display
checks cover hosted Windows 2025 and Ubuntu 24.04 X11/Xvfb compositor input, paint
and zoom. Physical displays, optical flicker, GPU hardware and Wayland are not
measured by those checks.
