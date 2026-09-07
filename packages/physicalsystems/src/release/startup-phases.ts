// SPDX-License-Identifier: Apache-2.0
/** Optional qualification diagnostics: fixed labels only, never runtime data. */
export const startupPhases = [
  "MAIN_ENTER",
  "PROFILE_READY",
  "LOGGING_BEFORE",
  "LOGGING_AFTER",
  "CRASH_REPORTER_BEFORE",
  "CRASH_REPORTER_AFTER",
  "SYSTEM_CERTIFICATES_BEFORE",
  "SYSTEM_CERTIFICATES_AFTER",
  "INSTANCE_LOCK_BEFORE",
  "INSTANCE_LOCK_ACQUIRED",
  "INSTANCE_LOCK_DENIED",
  "APP_READY_BEFORE",
  "APP_READY_AFTER",
  "OPERATOR_BEFORE",
  "OPERATOR_AFTER",
] as const
export type StartupPhase = (typeof startupPhases)[number]
