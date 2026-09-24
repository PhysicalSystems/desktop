// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import type {
  LeLabCameraBridge,
  LeLabDiscovery,
  LeLabFrame,
  LeLabResult,
} from "../../../physicalsystems/src/lelab-types"
import { createLeLabPreview } from "./lelab-preview"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const discovery: LeLabResult<LeLabDiscovery> = {
  ok: true,
  value: {
    url: "http://127.0.0.1:8000",
    robots: [
      {
        name: "SO101 Pair",
        cameras: [
          { id: "overview", name: "overview", width: 640, height: 480, fps: 30, previewAvailable: true },
          { id: "wrist", name: "wrist", width: 640, height: 480, fps: 30, previewAvailable: true },
        ],
      },
    ],
  },
}

test("Off during discovery cancels that generation and never starts cameras", async () => {
  const pending = deferred<LeLabResult<LeLabDiscovery>>()
  const stopped: string[] = []
  const reads: unknown[] = []
  const controller = createLeLabPreview(
    {
      discover: () => pending.promise,
      async frame(input) {
        reads.push(input)
        return { ok: false, code: "TIMEOUT" }
      },
      async stop(input) {
        stopped.push(input.clientId)
      },
    },
    {
      clear() {},
      robots() {
        throw Error("Late discovery")
      },
      frame() {},
      error() {},
    },
  )
  const start = controller.start("http://127.0.0.1:8000", "")
  controller.stop()
  pending.resolve(discovery)
  await start
  expect(stopped).toHaveLength(1)
  expect(reads).toHaveLength(0)
})

test("old frames cannot appear after switching robot/session generations", async () => {
  const pending: ReturnType<typeof deferred<LeLabResult<LeLabFrame>>>[] = []
  const requests: Parameters<LeLabCameraBridge["frame"]>[0][] = []
  const shown: string[] = []
  const stopped: string[] = []
  const controller = createLeLabPreview(
    {
      async discover() {
        return discovery
      },
      frame(input) {
        requests.push(input)
        const result = deferred<LeLabResult<LeLabFrame>>()
        pending.push(result)
        return result.promise
      },
      async stop(input) {
        stopped.push(input.clientId)
      },
    },
    {
      clear() {},
      robots() {},
      frame(id) {
        shown.push(id)
      },
      error() {},
    },
  )
  try {
    await controller.start("http://127.0.0.1:8000", "")
    expect(requests.map((item) => item.cameraId)).toEqual(["overview", "wrist"])
    await controller.start("http://127.0.0.1:8000", "SO101 Pair")
    expect(stopped).toEqual([requests[0].clientId])
    expect(requests[2].clientId).not.toBe(requests[0].clientId)
    const frame: LeLabResult<LeLabFrame> = {
      ok: true,
      value: { bytes: new Uint8Array(), contentType: "image/jpeg", receivedAt: Date.now() },
    }
    pending[0].resolve(frame)
    pending[1].resolve(frame)
    await Bun.sleep(0)
    expect(shown).toEqual([])
    pending[2].resolve(frame)
    pending[3].resolve(frame)
    await Bun.sleep(0)
    expect(shown).toEqual(["overview", "wrist"])
  } finally {
    controller.stop()
  }
})

test("multiple robots need explicit selection and do not open a camera", async () => {
  const reads: unknown[] = []
  const selections: string[] = []
  if (!discovery.ok) throw Error("Fixture")
  const robots = discovery.value.robots
  const controller = createLeLabPreview(
    {
      async discover() {
        return { ok: true, value: { ...discovery.value, robots: [...robots, { ...robots[0], name: "Second robot" }] } }
      },
      async frame(input) {
        reads.push(input)
        return { ok: false, code: "TIMEOUT" }
      },
      async stop() {},
    },
    {
      clear() {},
      robots(_, selected) {
        selections.push(selected)
      },
      frame() {},
      error() {},
    },
  )
  try {
    await controller.start("http://127.0.0.1:8000", "")
    expect(selections).toEqual([""])
    expect(reads).toEqual([])
  } finally {
    controller.stop()
  }
})

test("a missing saved robot is not silently replaced by the only remaining robot", async () => {
  const reads: unknown[] = []
  const selections: string[] = []
  const controller = createLeLabPreview(
    {
      async discover() {
        return discovery
      },
      async frame(input) {
        reads.push(input)
        return { ok: false, code: "TIMEOUT" }
      },
      async stop() {},
    },
    {
      clear() {},
      robots(_, selected) {
        selections.push(selected)
      },
      frame() {},
      error() {},
    },
  )
  try {
    await controller.start("http://127.0.0.1:8000", "A different saved robot")
    expect(selections).toEqual([""])
    expect(reads).toEqual([])
  } finally {
    controller.stop()
  }
})
