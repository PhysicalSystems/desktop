// SPDX-License-Identifier: Apache-2.0

// Both owned desktop builders bake this channel into the separate agent bundle.
// The public desktop's product identity and release channel are independent.
export const agentBuildChannel = "dev"

// Core database/database.ts uses this default when physicalEnvironment strips
// ambient OPENCODE_DB / OPENCODE_DISABLE_CHANNEL_DB overrides, as intended.
export const agentDatabaseName = ["latest", "beta", "prod"].includes(agentBuildChannel)
  ? "opencode.db"
  : `opencode-${agentBuildChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
