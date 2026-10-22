// SPDX-License-Identifier: Apache-2.0
export function exportWorkcellRoom(options: { root: string; output: string }): Promise<{
  output: string
  revision: string
  files: number
}>
