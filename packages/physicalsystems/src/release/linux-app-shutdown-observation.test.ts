// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { captureLinuxAppShutdown, captureLinuxAppShutdownWithReader } from "./linux-app-shutdown-observation"

const privateMarker = "PRIVATE-PROCESS-IDENTITY"
const targets = () => ({
  uid: 1001,
  runtime: { pid: 1100, executable: `/owned/${privateMarker}/runtime` },
  electron: { pid: 1101, executable: `/owned/${privateMarker}/electron` },
})
const error = (code: string) => Object.assign(Error(privateMarker), { code, path: `/${privateMarker}` })
const procStat = (pid: number, birth = "9007199254740993", state = "S") => {
  const fields = [state, ...Array.from({ length: 18 }, () => "0"), birth, "0", "0"]
  return `${pid} (${privateMarker} ) nested) ${fields.join(" ")}\n`
}

function fixture() {
  const input = targets()
  const rows = new Map(
    [input.runtime, input.electron].map((owner) => [
      owner.pid,
      { birth: "9007199254740993", state: "S", uid: input.uid, executable: owner.executable, present: true },
    ]),
  )
  const calls: { pid: number; field: string }[] = []
  const read = async (pid: number, field: "stat" | "status" | "executable", signal: AbortSignal) => {
    signal.throwIfAborted()
    calls.push({ pid, field })
    const row = rows.get(pid)!
    if (!row.present) throw error("ENOENT")
    if (field === "stat") return procStat(pid, row.birth, row.state)
    if (field === "status")
      return `Name:\t${privateMarker}\nPid:\t${pid}\nUid:\t${row.uid}\t${row.uid}\t${row.uid}\t${row.uid}\n`
    if (row.state === "Z") throw error("ENOENT")
    return row.executable
  }
  return { input, rows, calls, read }
}

test("copied Linux identities distinguish same live and same zombie without exposing private fields", async () => {
  const f = fixture()
  const observer = await captureLinuxAppShutdownWithReader(f.input, f.read)
  f.input.uid = 99
  f.input.runtime.pid = 999
  f.input.runtime.executable = "/untrusted/mutation"
  f.rows.get(1101)!.state = "Z"
  const observed = await observer.observe()
  expect(observed).toEqual({
    diagnosticOnly: true,
    runtime: { captured: true, state: "same-live" },
    electron: { captured: true, state: "same-zombie" },
  })
  expect(Object.isFrozen(observer)).toBe(true)
  expect(Object.isFrozen(observed)).toBe(true)
  expect(Object.isFrozen(observed.runtime)).toBe(true)
  expect(JSON.stringify(observer)).toBe("{}")
  for (const text of [JSON.stringify(observer), JSON.stringify(observed)]) {
    expect(text).not.toContain(privateMarker)
    expect(text).not.toContain("1100")
    expect(text).not.toContain("1001")
    expect(text).not.toContain("9007199254740993")
  }
  expect(new Set(f.calls.map((call) => call.field))).toEqual(new Set(["stat", "status", "executable"]))
})

test("an auxiliary missing file is absence only after a fresh exact-PID stat confirms disappearance", async () => {
  for (const field of ["status", "executable"] as const) {
    const f = fixture()
    let observing = false
    const reader: typeof f.read = async (pid, kind, signal) => {
      if (observing && pid === 1101 && kind === field) {
        f.rows.get(pid)!.present = false
        throw error("ENOENT")
      }
      return f.read(pid, kind, signal)
    }
    const observer = await captureLinuxAppShutdownWithReader(f.input, reader)
    observing = true
    f.calls.length = 0
    expect((await observer.observe()).electron).toEqual({ captured: true, state: "absent" })
    expect(f.calls.filter((call) => call.pid === 1101).at(-1)?.field).toBe("stat")
  }
})

test("live missing exe, unreadable metadata and malformed proc fields cannot imply disappearance", async () => {
  for (const variation of [
    "missing-exe",
    "denied-status",
    "malformed-status",
    "malformed-stat",
    "wrong-stat-pid",
    "duplicate-uid",
  ]) {
    const f = fixture()
    let observing = false
    const reader: typeof f.read = async (pid, field, signal) => {
      if (observing && pid === 1101) {
        if (variation === "missing-exe" && field === "executable") throw error("ENOENT")
        if (variation === "denied-status" && field === "status") throw error("EACCES")
        if (variation === "malformed-status" && field === "status") return privateMarker
        if (variation === "malformed-stat" && field === "stat") return procStat(pid, "wrong")
        if (variation === "wrong-stat-pid" && field === "stat") return procStat(pid + 1)
        if (variation === "duplicate-uid" && field === "status")
          return (await f.read(pid, field, signal)) + "Uid:\t1001\t1001\t1001\t1001\n"
      }
      return f.read(pid, field, signal)
    }
    const observer = await captureLinuxAppShutdownWithReader(f.input, reader)
    observing = true
    const observation = await observer.observe()
    expect(observation.electron.state).toBe(variation === "missing-exe" ? "identity-unconfirmed" : "unreadable")
    expect(JSON.stringify(observation)).not.toContain(privateMarker)
  }
})

test("exact birth changes identify PID reuse before or during auxiliary reads without matching executable authority", async () => {
  for (const duringRead of [false, true]) {
    const f = fixture()
    let observing = false
    const reader: typeof f.read = async (pid, field, signal) => {
      if (observing && duringRead && pid === 1101 && field === "status") f.rows.get(pid)!.birth = "9007199254740994"
      return f.read(pid, field, signal)
    }
    const observer = await captureLinuxAppShutdownWithReader(f.input, reader)
    observing = true
    if (!duringRead) f.rows.get(1101)!.birth = "9007199254740994"
    expect((await observer.observe()).electron).toEqual({ captured: true, state: "reused" })
  }
})

test("same birth with another executable or UID remains identity-unconfirmed", async () => {
  for (const field of ["uid", "executable"] as const) {
    const f = fixture()
    const observer = await captureLinuxAppShutdownWithReader(f.input, f.read)
    if (field === "uid") f.rows.get(1101)!.uid++
    else f.rows.get(1101)!.executable += " (deleted)"
    expect((await observer.observe()).electron.state).toBe("identity-unconfirmed")
  }
})

test("PID reuse, zombie or untrusted identity during initial capture never creates an anchor", async () => {
  for (const mode of ["birth", "uid", "exe", "zombie"] as const) {
    const f = fixture()
    let statReads = 0
    const reader: typeof f.read = async (pid, field, signal) => {
      if (pid === 1101) {
        if (mode === "birth" && field === "stat" && ++statReads === 2) f.rows.get(pid)!.birth = "9007199254740994"
        if (mode === "uid") f.rows.get(pid)!.uid = 99
        if (mode === "exe") f.rows.get(pid)!.executable = "/other/executable"
        if (mode === "zombie") f.rows.get(pid)!.state = "Z"
      }
      return f.read(pid, field, signal)
    }
    const observer = await captureLinuxAppShutdownWithReader(f.input, reader)
    f.calls.length = 0
    expect((await observer.observe()).electron).toEqual({ captured: false, state: "identity-unconfirmed" })
    expect(f.calls.some((call) => call.pid === 1101)).toBe(false)
  }
})

test("unresolved diagnostic reads expire without partial state claims or further calls after late resolution", async () => {
  const f = fixture()
  let observing = false
  let resume!: (value: string) => void
  const reader: typeof f.read = async (pid, field, signal) => {
    if (observing && pid === 1101 && field === "stat")
      return new Promise((resolve) => {
        resume = resolve
      })
    return f.read(pid, field, signal)
  }
  const observer = await captureLinuxAppShutdownWithReader(f.input, reader, 10)
  observing = true
  const result = await observer.observe()
  expect(result.runtime.state).toBe("unreadable")
  expect(result.electron.state).toBe("unreadable")
  const before = f.calls.length
  resume(procStat(1101))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.calls).toHaveLength(before)
})

test("invalid targets and actual production entry refuse unsupported access before any proc reader runs", async () => {
  let reads = 0
  for (const invalid of [
    { ...targets(), runtime: { pid: 0, executable: "/owned/runtime" } },
    { ...targets(), electron: { pid: 1101, executable: "/owned/../other" } },
    { ...targets(), electron: { pid: 1101, executable: "/owned/runtime\nPRIVATE" } },
    { ...targets(), uid: -1 },
  ])
    await expect(
      captureLinuxAppShutdownWithReader(invalid, async () => {
        reads++
        return ""
      }),
    ).rejects.toThrow("LINUX_APP_SHUTDOWN_OBSERVATION_UNAVAILABLE")
  expect(reads).toBe(0)
  await expect(captureLinuxAppShutdown({ ...targets(), env: {}, root: "/not-a-runner-root" })).rejects.toThrow(
    "LINUX_APP_SHUTDOWN_OBSERVATION_UNAVAILABLE",
  )
})
