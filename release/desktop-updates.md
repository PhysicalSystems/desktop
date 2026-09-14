# Desktop updater integration

Physical Systems reuses OpenCode's update interface, IPC subscriptions, shared
controller, and pinned `electron-updater` download machinery. Public previews use
our release-selection and native installation adapters, described in
[Preview installer updates](../packages/desktop/PREVIEW_UPDATES.md).

The library supports unsigned Windows NSIS and Linux Debian updates. Signing is
an explicit release policy, not a technical prerequisite for an Update button.
The preview flow verifies consistency with official HTTPS release metadata and
installer hashes; it does not claim publisher-signature authentication.

## Owned release selection

The download repository contains several products, with Desktop tags named
`desktop-v<version>`. The website's selected release is the authoritative Desktop
choice. Discovery validates that selection against GitHub release identity,
channel, asset names, sizes and hashes before giving the selected URL and SHA-256 to the
library's HTTP executor. The existing private cache and pre-install owned-file
verification remain; a second library cache would duplicate those responsibilities. It never uses the upstream OpenCode release feed.

The controller owns update state, progress, concurrent requests and confirmation.
The Physical Systems adapter adds selected-release revalidation, owned-service
shutdown, installation observations and the attempt journal. Retained metadata
never authorizes a download, installation or retry by itself.

## Native installation adapter

Windows runs the original interactive NSIS installer, which owns reopening the
app. Ubuntu uses fixed asynchronous `pkexec dpkg --refuse-downgrade --install`
arguments and confirms the installed package version before relaunching. This
intentionally differs from the library's Debian installer, which can attempt
package-manager repair after a failed installation.

Both platforms stop the operator and other owned services before installer
handoff and preserve uncertain outcomes for explicit recovery. These app-specific
requirements are not supplied by the upstream updater or its download cache.

## Future signed feed

`UPDATER_ENABLED` remains false for the original native feed. There is no second,
unconnected policy resolver or runtime-environment switch. Enabling signed
updates requires an owned feed, a configured publisher, verification of the real
native signature checker, and tests of actual signed installers. The packaged
configuration and selected artifacts must be bound to the reviewed release;
a boolean or publisher name alone does not prove that verification occurred.

A signed release must retain and validate any update metadata it publishes, test
wrong-publisher and unsigned rejection, and qualify installation, restart and
recovery on each supported platform. Follow the
[public producer](public-producer.md) and [protected publisher](public-publisher.md).
Unsigned preview test results do not qualify the signed feed.
