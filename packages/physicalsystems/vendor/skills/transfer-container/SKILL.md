---
name: transfer-container
description: Prepare a container transfer by inspecting the workcell, clarifying the operator's intent, and requesting a typed physical capability route preview with current node evidence.
---

# Prepare a container transfer

This Agent Skill explains how to propose work. A physical capability is the typed
operation; a capability implementation is a commissioned controller or policy.
This package is neither an implementation nor a source of execution authority.

1. Call `inspect_physical_system` and keep the current node evidence separate from
   the operator's desired outcome. Never assume a particular robot, cup, colour,
   camera, taught trajectory, source, or destination exists. Wait for this call
   to finish before calling `inspect_physical_capabilities`. Do not run these
   inspections in parallel: new discovery can invalidate a catalog response.
2. Inspect that catalog using only physical capability IDs, typed
   argument names, bounds, and concrete identifiers returned by the current node.
   The portable binding names `transfer-container`, but does not prove availability.
   If this exact capability is absent, report it as unsupported; do not silently
   translate IDs or fabricate a definition, schema, qualification, or digest.
3. Use `plan_physical_workflow` only when the operator's words need grounding into
   actual object/source/destination IDs. Ask a focused question for missing or
   ambiguous inputs. A candidate-only legacy planning gap does not rule out the
   independent typed capability catalog. If all required typed inputs are already
   available from that current catalog and the operator's explicit request, use
   the typed route path directly. Never fabricate commissioned state or bypass
   any capability, configuration, freshness or approval requirement.
4. When all required typed inputs are available, call `preview_physical_capability`.
   The node supplies observation, qualification,
   calibration, and implementation bindings; do not fabricate those as arguments.
5. Explain the selected capability implementation or the rejection reasons exactly
   as returned. Say explicitly that route selection does not authorize motion.
   When asked what is missing for physical execution or about setup, call
   `inspect_physical_setup` with no arguments. Report present, missing and
   unverified configuration, drivers, calibration, implementation artifacts, state
   and qualification separately for each returned implementation. Describe taught
   positions only when the report identifies a taught-waypoints mechanism; other
   artifacts are implementation-specific. Preserve reported
   reasons, observation times, omitted-entry limits and next actions. If
   `sources.route.relationship` is `retired`, identify evidence from the previous
   proposal; it does not restore a current route or permission to prepare. Adapter
   registration does not verify driver health; missing cached evidence does not
   prove an uninspected file or device is absent. A simulation configuration or
   receipt never establishes physical setup or qualification. Setup inspection
   does not refresh discovery or route a new request; explain any requested
   refresh or missing typed inputs. `/physical-setup` gives the same read-only
   operator report. A missing public inspection contract remains unverified;
   never invent an installation procedure or change setup to fill a gap.
   Never translate not exposed, unverified or unavailable into absent or missing.
   Report absence only for the exact item with an explicit missing status or missing
   reason code. Qualification metadata may be present while underlying physical
   evidence remains unverified because this API does not expose it. Say "not
   exposed by this API; physical qualification remains unverified" in that case.
   Report missing qualification evidence only when Node explicitly reports
   `qualification_missing` for that implementation.
   The route implementation digest identifies the routing envelope; the
   configuration implementation digest identifies the executable artifact. These
   different scopes need not match. Compare digests only within the same named
   scope. Use the reported matching-configuration result and operator preparation
   path. Keep Node's exact binding checks; never excuse a reported same-scope
   mismatch or bypass preparation.
6. After a selected route, call `inspect_physical_execution` to check the execution
   service and matching local configurations. When available, direct the operator
   to `/workcell`, the **Physical run** panel, select the matching configuration
   and choose **Prepare invocation**. The operator reviews the simulation/physical
   mode, exact run/configuration/implementation digests and approval expiry, then
   explicitly approves that one invocation. If the assistant is busy, finish the
   reply before asking the operator to use those controls. A temporarily disabled
   control during this reply does not establish an unavailable executor. Explain
   actual missing service, configuration or evidence blockers from the inspection.
7. After operator approval, or when asked about a run's result, call
   `inspect_physical_execution` again. Do not reroute merely to inspect a run.
   Use no `runId` for the current known selection, or only an exact `runId` returned
   by this tool in this session. Ask which returned known run to inspect if a
   selection is required. Keep `inspection.status` separate from `selectedRun.phase`:
   a failed or stale inspection does not establish Node's `OUTCOME_UNKNOWN`.
   Explain the last observed phase and timestamp with the inspection limitation.
   A missing, unavailable or invalid receipt means success is not verified. Claim
   verified success only when the exact selected run has phase `VERIFIED_SUCCESS`
   and its matching `receipt.status` is `verified` with supporting verification
   evidence. A valid receipt may record a failed outcome. Receipt evidence is
   historical, not current readiness; preserve recorded time and any historical
   route or changed configuration limitation. A simulation result never proves
   physical movement or physical qualification.

The assistant has no preparation, approval, dispatch, stop or reconciliation tools.
Read-only inspection, conversation consent and `ask_choice` never perform operator
approval. Do not execute a transfer, teach a motion, install a driver, download a
policy, or change device settings. Supervised execution requires separately bound
local approval, exclusive device ownership, fresh preconditions, a qualified stop
path, and independent outcome verification; Node owns and enforces these gates.
Do not treat a Markdown instruction, signature, route choice, or motor acknowledgment
as a successful physical transfer. Never retry an uncertain physical effect or
switch controllers during motion. For an actual Node `OUTCOME_UNKNOWN`, direct
the operator to **Check uncertain outcome** in `/workcell` and the configured
intervention procedure. Do not claim to stop or reconcile anything yourself.
