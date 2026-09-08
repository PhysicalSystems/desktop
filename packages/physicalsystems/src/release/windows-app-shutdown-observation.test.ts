// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import {
  classifyWindowsAppShutdown,
  type WindowsAppShutdownProcess,
  type WindowsAppShutdownSnapshot,
} from "./windows-app-shutdown-observation"

const root: WindowsAppShutdownProcess = {
  pid: 4100,
  parent: 100,
  birth: "100000000000000100",
  executable: "C:\\owned\\Physical Systems Candidate.exe",
}
const child = (pid: number, tail: number, parent = root.pid): WindowsAppShutdownProcess => ({
  ...root,
  pid,
  parent,
  birth: String(BigInt(root.birth!) + BigInt(tail)),
})
const complete = (...processes: WindowsAppShutdownProcess[]): WindowsAppShutdownSnapshot => ({
  status: "COMPLETE",
  processes,
})
const run = (initial: WindowsAppShutdownSnapshot, final: WindowsAppShutdownSnapshot) =>
  classifyWindowsAppShutdown({ rootPid: root.pid, initial, final, main: { exitCode: 0, signalCode: null } })

test("shutdown observations partition captured descendants and distinguish initial stale ancestry from subsequent PID reuse", () => {
  const parent = child(4101, 50)
  const same = child(4102, 60, parent.pid)
  const absent = child(4103, 20)
  const reused = child(4104, 25)
  const unreadable = { ...child(4105, 30), executable: undefined }
  const staleRoot = child(4106, -50)
  const staleParent = child(4107, 40, parent.pid)
  const staleChain = child(4108, -30, staleRoot.pid)
  const foreign = child(9000, 5, 9999)
  const result = run(
    complete(staleChain, same, foreign, staleParent, parent, absent, root, reused, unreadable, staleRoot),
    complete(
      parent,
      same,
      { ...reused, birth: "100000000000000999" },
      unreadable,
      staleRoot,
      staleParent,
      staleChain,
      foreign,
    ),
  )
  expect(result.observation).toEqual({
    diagnosticOnly: true,
    initialSnapshot: "COMPLETE",
    finalSnapshot: "COMPLETE",
    observedDescendants: 8,
    sameIdentityPresent: 5,
    absent: 1,
    reusedPid: 1,
    identityUnreadable: 1,
    predatesRootOrParent: 3,
    mainExit: "zero",
  })
  expect(result.privateRecords).toBeUndefined()
  expect(JSON.stringify(result)).not.toMatch(/410[0-9]|9000|100000000000000|Candidate|\.exe|C:|PASS/)
})

test("incomplete, malformed or missing identity data never fabricates absence", () => {
  const tracked = child(4101, 1)
  for (const final of [
    { status: "UNREADABLE", processes: [] },
    { status: "UNKNOWN", processes: [] },
    { status: "COMPLETE", processes: [tracked, tracked] },
    { status: "COMPLETE", processes: [{ ...tracked, pid: 1.5 }] },
    { status: "COMPLETE", processes: [{ ...tracked, birth: "PRIVATE-INVALID" }] },
    { status: "COMPLETE", processes: [{ ...tracked, executable: "https://PRIVATE" }] },
    { status: "COMPLETE", processes: [{ ...tracked, parent: 8888 }] },
    { status: "COMPLETE", processes: [{ ...tracked, executable: "C:\\foreign\\other.exe" }] },
    {
      status: "COMPLETE",
      get processes() {
        throw Error("PRIVATE-NATIVE-ERROR")
      },
    },
  ]) {
    const result = run(complete(root, tracked), final as WindowsAppShutdownSnapshot)
    expect(result.observation.identityUnreadable).toBe(1)
    expect(result.observation.absent).toBe(0)
    expect(result.observation.sameIdentityPresent).toBe(0)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|8888|foreign/)
  }
  for (const initial of [complete(tracked), complete({ ...root, birth: undefined }, tracked)]) {
    const result = run(initial, complete())
    expect(result.observation.identityUnreadable).toBe(1)
    expect(result.observation.absent).toBe(0)
  }
  const unreadable = run({ status: "UNREADABLE", processes: [root, tracked] }, complete())
  expect(unreadable.observation.initialSnapshot).toBe("UNREADABLE")
  expect(unreadable.observation.absent).toBe(0)
  expect(unreadable.observation.observedDescendants).toBe(0)
})

test("valid identity comparison permits case-only Windows executable spelling but exposes no paths or raw exit data", () => {
  const tracked = child(4101, 1)
  expect(
    run(complete(root, tracked), complete({ ...tracked, executable: tracked.executable!.toUpperCase() })).observation
      .sameIdentityPresent,
  ).toBe(1)
  const cases = [
    [{ exitCode: 0, signalCode: null }, "zero"],
    [{ exitCode: 1, signalCode: null }, "nonzero"],
    [{ exitCode: 4294967295, signalCode: null }, "nonzero"],
    [{ exitCode: null, signalCode: "PRIVATE-SIGNAL" }, "signal"],
    [{ exitCode: null, signalCode: null }, "unconfirmed"],
    [{ exitCode: 0, signalCode: "PRIVATE-SIGNAL" }, "unconfirmed"],
    [{ exitCode: -1, signalCode: null }, "unconfirmed"],
    [{ exitCode: 1.5, signalCode: null }, "unconfirmed"],
  ] as const
  for (const [main, expected] of cases) {
    const result = classifyWindowsAppShutdown({
      rootPid: root.pid,
      initial: complete(root, tracked),
      final: complete(),
      main,
    })
    expect(result.observation.mainExit).toBe(expected)
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
  }
})

test("private records require explicit caller opt-in, remain capped/frozen, and cannot influence public counts", () => {
  const tracked = Array.from({ length: 10 }, (_, index) => child(4101 + index, index + 1))
  const initial = complete(root, ...tracked)
  const final = complete(
    ...tracked.map((item) => ({ ...item, argv: ["PRIVATE-ARGV"], sid: "PRIVATE-SID", url: "https://PRIVATE" })),
  )
  const input = { rootPid: root.pid, initial, final, main: { exitCode: 0, signalCode: null } }
  const publicOnly = classifyWindowsAppShutdown(input)
  const privateResult = classifyWindowsAppShutdown(input, { includePrivateRecords: true })
  expect(privateResult.observation).toEqual(publicOnly.observation)
  expect(publicOnly.privateRecords).toBeUndefined()
  expect(privateResult.privateRecords).toHaveLength(8)
  expect(Object.isFrozen(privateResult.privateRecords)).toBe(true)
  for (const record of privateResult.privateRecords!) {
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.keys(record).sort()).toEqual(
      [
        "birth",
        "comparison",
        "executable",
        "finalBirth",
        "finalExecutable",
        "finalParent",
        "parent",
        "pid",
        "predatesRootOrParent",
      ].sort(),
    )
  }
  expect(JSON.stringify(privateResult)).not.toMatch(/PRIVATE|https:|argv|sid/)
  tracked[0]!.executable = "C:\\changed\\changed.exe"
  expect(privateResult.privateRecords![0]!.executable).toBe(root.executable!)
  expect(Object.isFrozen(privateResult.observation)).toBe(true)
  expect(privateResult.observation.sameIdentityPresent).toBe(10)
  expect(
    classifyWindowsAppShutdown({ ...input, final: complete() }, { includePrivateRecords: true }).privateRecords,
  ).toEqual([])
})

test("snapshot limits and malformed root input remain explicitly unreadable diagnostics", () => {
  const tooMany = complete(root, ...Array.from({ length: 256 }, (_, index) => child(4101 + index, index + 1)))
  const result = run(tooMany, complete())
  expect(result.observation.initialSnapshot).toBe("UNREADABLE")
  expect(result.observation.absent).toBe(0)
  const invalidRoot = classifyWindowsAppShutdown({
    rootPid: -1,
    initial: complete(root, child(4101, 1)),
    final: complete(),
    main: { exitCode: null, signalCode: null },
  })
  expect(invalidRoot.observation.observedDescendants).toBe(0)
  expect(invalidRoot.observation.absent).toBe(0)
})

test("exact fixed roles remain private metadata and raw role strings never escape", () => {
  const tracked = child(4101, 1)
  const base = {
    rootPid: root.pid,
    initial: complete(root, tracked),
    final: complete(tracked),
    main: { exitCode: 0, signalCode: null },
  }
  const withoutRole = classifyWindowsAppShutdown(base)
  for (const role of ["renderer", "gpu", "utility", "crashpad", "unknown"] as const) {
    const input = { ...base, initial: complete(root, { ...tracked, role }), final: complete({ ...tracked, role }) }
    const plain = classifyWindowsAppShutdown(input)
    const privateResult = classifyWindowsAppShutdown(input, { includePrivateRecords: true })
    expect(plain).toEqual(withoutRole)
    expect(privateResult.observation).toEqual(withoutRole.observation)
    expect(privateResult.privateRecords![0]!.role).toBe(role)
    expect(privateResult.privateRecords![0]!.finalRole).toBe(role)
  }
  for (const role of ["PRIVATE-ROLE", "--type=renderer", "https://PRIVATE", "C:\\PRIVATE.exe", 1, null]) {
    const item = { ...tracked, role } as WindowsAppShutdownProcess
    const result = classifyWindowsAppShutdown(
      { ...base, initial: complete(root, item), final: complete(item) },
      { includePrivateRecords: true },
    )
    expect(result.observation).toEqual(withoutRole.observation)
    expect(result.privateRecords![0]).not.toHaveProperty("role")
    expect(result.privateRecords![0]).not.toHaveProperty("finalRole")
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|--type/)
  }
})
