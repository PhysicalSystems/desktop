// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { PassThrough } from "node:stream"
import { credentialBackend, observeCredentialBackend } from "./credential-backend"
import { credentialTrace } from "../../../desktop/src/main/credential-trace"

test("native backend labels require real availability and reject Linux plaintext/unknown fallbacks", () => {
  for (const selected of ["basic_text", "unknown", "fixture", "gnome_libsecret\ncredential-trap", undefined]) {
    expect(
      credentialBackend({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => selected! }, "linux"),
    ).toBeUndefined()
  }
  expect(credentialBackend({ isEncryptionAvailable: () => false }, "win32")).toBeUndefined()
  expect(credentialBackend({ isEncryptionAvailable: () => true }, "win32")).toBe("windows_dpapi")
  expect(credentialBackend({ isEncryptionAvailable: () => true }, "darwin")).toBeUndefined()
  expect(
    credentialBackend(
      { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret" },
      "linux",
    ),
  ).toBe("gnome_libsecret")
})

test("successful-vault diagnostic opt-in emits only a fixed backend label and cannot change production control flow", () => {
  const writes: string[] = []
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret" }
  for (const flag of [undefined, "", "0", "true", " 1", "1 "]) {
    credentialTrace(storage, {
      env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: flag },
      platform: "linux",
      write: (_, text) => writes.push(text),
    })
  }
  expect(writes).toEqual([])
  credentialTrace(storage, {
    env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1", PRIVATE_TOKEN: "credential-trap" },
    platform: "linux",
    write: (_, text) => writes.push(text),
  })
  expect(writes).toEqual(["PHYSICALSYSTEMS_CREDENTIAL_gnome_libsecret\n"])
  expect(JSON.stringify(writes)).not.toContain("credential-trap")
  expect(() =>
    credentialTrace(storage, {
      env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1" },
      platform: "linux",
      write: () => {
        throw new Error("credential-trap")
      },
    }),
  ).not.toThrow()
})

test("backend observation handles stream boundaries, requires expected native backend and rejects mixed evidence", () => {
  const child = new EventEmitter() as ChildProcess
  child.stderr = new PassThrough()
  const observed = observeCredentialBackend(child, "linux")
  expect(() => observed.result()).toThrow("CREDENTIAL_PROBE_BACKEND_UNCONFIRMED")
  child.stderr.emit("data", "credential-trap\nPHYSICALSYSTEMS_CREDENTIAL_gnome_")
  child.stderr.emit("data", "libsecret\r\n")
  expect(observed.result()).toBe("gnome_libsecret")
  child.stderr.emit("data", "credential-trap".repeat(4000))
  child.stderr.emit("data", "\nPHYSICALSYSTEMS_CREDENTIAL_windows_dpapi\n")
  expect(() => observed.result()).toThrow("CREDENTIAL_PROBE_BACKEND_UNCONFIRMED")
  observed.dispose()
  expect(child.stderr.listenerCount("data")).toBe(0)
  const windows = observeCredentialBackend(child, "win32")
  child.stderr.emit("data", "prefix PHYSICALSYSTEMS_CREDENTIAL_windows_dpapi\n")
  expect(() => windows.result()).toThrow("UNCONFIRMED")
  child.stderr.emit("data", "PHYSICALSYSTEMS_CREDENTIAL_windows_dpapi\n")
  expect(windows.result()).toBe("windows_dpapi")
  windows.dispose()
})
