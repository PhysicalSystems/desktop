// SPDX-License-Identifier: Apache-2.0
declare module "virtual:physicalsystems-operator" {
  export const agentToolDefinitions: readonly unknown[]
  export function createOperatorService(options: Record<string, unknown>): Promise<unknown>
}
