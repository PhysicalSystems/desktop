// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { trustedRenderer } from "./renderer-authority"

test("operator IPC is limited to the owned renderer main frame", () => {
  const valid = { windowMatches: true, mainFrame: true, url: "oc://renderer/index.html", packaged: true }
  expect(trustedRenderer(valid)).toBe(true)
  for (const url of ["https://renderer/", "oc://renderer.evil/", "oc://other/", "oc://x@renderer/", "file:///tmp/index.html"]) expect(trustedRenderer({ ...valid, url })).toBe(false)
  expect(trustedRenderer({ ...valid, mainFrame: false })).toBe(false)
  expect(trustedRenderer({ ...valid, windowMatches: false })).toBe(false)
  expect(trustedRenderer({ ...valid, packaged: false, url: "http://127.0.0.1:5173/index.html", developmentURL: "http://127.0.0.1:5173" })).toBe(true)
  expect(trustedRenderer({ ...valid, packaged: false, url: "http://127.0.0.1:5174/", developmentURL: "http://127.0.0.1:5173" })).toBe(false)
})
