// SPDX-License-Identifier: Apache-2.0

const roles = ["renderer", "gpu", "utility", "crashpad", "unknown"] as const
export type WindowsAppShutdownRole = (typeof roles)[number]
export type WindowsAppShutdownProcess = {
  pid: number
  parent: number
  birth?: string
  executable?: string
  role?: WindowsAppShutdownRole
}
export type WindowsAppShutdownSnapshot = {
  status: "COMPLETE" | "UNREADABLE"
  processes: readonly WindowsAppShutdownProcess[]
}
type Comparison = "sameIdentityPresent" | "absent" | "reusedPid" | "identityUnreadable"
export type WindowsAppShutdownPrivateRecord = Readonly<{
  pid: number
  parent: number
  birth?: string
  executable?: string
  role?: WindowsAppShutdownRole
  finalParent?: number
  finalBirth?: string
  finalExecutable?: string
  finalRole?: WindowsAppShutdownRole
  comparison: Comparison
  predatesRootOrParent: boolean
}>

const pid = (value: unknown, allowZero = false): value is number =>
  Number.isSafeInteger(value) && Number(value) >= (allowZero ? 0 : 1) && Number(value) <= 2147483647
const birth = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)
const executable = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z]:\\[^\r\n\0]{1,32760}$/.test(value)
const role = (value: unknown): value is WindowsAppShutdownRole =>
  typeof value === "string" && roles.includes(value as WindowsAppShutdownRole)

function snapshot(value: WindowsAppShutdownSnapshot): WindowsAppShutdownSnapshot {
  const unreadable: WindowsAppShutdownSnapshot = { status: "UNREADABLE", processes: [] }
  try {
    if (value?.status !== "COMPLETE" || !Array.isArray(value.processes) || value.processes.length > 256)
      return unreadable
    const seen = new Set<number>()
    const processes: WindowsAppShutdownProcess[] = []
    for (const item of value.processes) {
      if (!item || !pid(item.pid) || !pid(item.parent, true) || seen.has(item.pid)) return unreadable
      seen.add(item.pid)
      // Copy only these fields. Partial native identities stay unreadable; raw
      // metadata, getters, errors and arbitrary strings never enter the result.
      processes.push({
        pid: item.pid,
        parent: item.parent,
        ...(birth(item.birth) ? { birth: item.birth } : {}),
        ...(executable(item.executable) ? { executable: item.executable } : {}),
        ...(role(item.role) ? { role: item.role } : {}),
      })
    }
    return { status: "COMPLETE", processes }
  } catch {
    return unreadable
  }
}

function mainExit(value: { exitCode: number | null; signalCode: string | null }) {
  try {
    if (value.exitCode === null && typeof value.signalCode === "string" && value.signalCode.length > 0)
      return "signal" as const
    if (
      value.signalCode !== null ||
      !Number.isSafeInteger(value.exitCode) ||
      value.exitCode! < 0 ||
      value.exitCode! > 0xffffffff
    )
      return "unconfirmed" as const
    return value.exitCode === 0 ? ("zero" as const) : ("nonzero" as const)
  } catch {
    return "unconfirmed" as const
  }
}

/** Failure-only diagnostics. This does not establish process ownership, grant
 * signal/delete authority, or change a cleanup result. The caller must validate
 * an encryption recipient before opting into the bounded private records. */
export function classifyWindowsAppShutdown(
  input: {
    rootPid: number
    initial: WindowsAppShutdownSnapshot
    final: WindowsAppShutdownSnapshot
    main: { exitCode: number | null; signalCode: string | null }
  },
  options: { includePrivateRecords?: boolean } = {},
) {
  const initial = snapshot(input.initial)
  const final = snapshot(input.final)
  const byPid = new Map(initial.processes.map((item) => [item.pid, item]))
  const afterByPid = new Map(final.processes.map((item) => [item.pid, item]))
  const root = pid(input.rootPid) ? byPid.get(input.rootPid) : undefined
  // Match the existing initial numeric ancestry capture, including stale
  // ParentProcessId links. They are diagnosed, never silently removed from it.
  const selected = new Set<number>(pid(input.rootPid) ? [input.rootPid] : [])
  for (let count = -1; count !== selected.size; ) {
    count = selected.size
    for (const item of initial.processes) if (selected.has(item.parent)) selected.add(item.pid)
  }
  const observation = {
    diagnosticOnly: true as const,
    initialSnapshot: initial.status,
    finalSnapshot: final.status,
    observedDescendants: 0,
    sameIdentityPresent: 0,
    absent: 0,
    reusedPid: 0,
    identityUnreadable: 0,
    predatesRootOrParent: 0,
    mainExit: mainExit(input.main),
  }
  const privateRecords: WindowsAppShutdownPrivateRecord[] = []
  for (const item of initial.processes) {
    if (item.pid === input.rootPid || !selected.has(item.pid)) continue
    observation.observedDescendants++
    const parent = byPid.get(item.parent)
    const predates = Boolean(
      item.birth &&
        ((root?.birth && BigInt(item.birth) < BigInt(root.birth)) ||
          (parent?.birth && BigInt(item.birth) < BigInt(parent.birth))),
    )
    if (predates) observation.predatesRootOrParent++
    const after = afterByPid.get(item.pid)
    let comparison: Comparison
    if (!root?.birth || !root.executable || !item.birth || !item.executable || final.status !== "COMPLETE")
      comparison = "identityUnreadable"
    else if (!after) comparison = "absent"
    else if (!after.birth || !after.executable) comparison = "identityUnreadable"
    else if (after.birth !== item.birth) comparison = "reusedPid"
    else if (after.parent === item.parent && after.executable.toLowerCase() === item.executable.toLowerCase())
      comparison = "sameIdentityPresent"
    else comparison = "identityUnreadable"
    observation[comparison]++
    // Absent processes need no private identity dump. Keep at most eight
    // anomalous/present records; public counters remain the complete snapshot.
    if (options.includePrivateRecords === true && privateRecords.length < 8 && (comparison !== "absent" || predates))
      privateRecords.push(
        Object.freeze({
          pid: item.pid,
          parent: item.parent,
          ...(item.birth ? { birth: item.birth } : {}),
          ...(item.executable ? { executable: item.executable } : {}),
          ...(item.role ? { role: item.role } : {}),
          ...(after ? { finalParent: after.parent } : {}),
          ...(after?.birth ? { finalBirth: after.birth } : {}),
          ...(after?.executable ? { finalExecutable: after.executable } : {}),
          ...(after?.role ? { finalRole: after.role } : {}),
          comparison,
          predatesRootOrParent: predates,
        }),
      )
  }
  return Object.freeze({
    observation: Object.freeze(observation),
    ...(options.includePrivateRecords === true ? { privateRecords: Object.freeze(privateRecords) } : {}),
  })
}
