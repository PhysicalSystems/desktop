// SPDX-License-Identifier: Apache-2.0

// Both owned desktop builders bake this channel into the separate agent bundle.
// The public desktop's product identity and release channel are independent.
export const agentBuildChannel = "dev"

// Retain the beta profile's database name across the V2 runtime migration.
// The owned launcher sets this exact path after stripping ambient DB overrides;
// V2's generic default is no longer channel-specific.
export const agentDatabaseName = ["latest", "beta", "prod"].includes(agentBuildChannel)
  ? "opencode.db"
  : `opencode-${agentBuildChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
