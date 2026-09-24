import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { LeLabCameras } from "../../../src/physicalsystems/lelab-cameras"
import type {
  LeLabCameraBridge,
  LeLabConnection,
  LeLabFrame,
  LeLabFrameRequest,
  LeLabResult,
} from "../../../../physicalsystems/src/lelab-types"
import overview from "./overview.jpg?inline"
import wrist from "./wrist.jpg?inline"
import "../../../src/physicalsystems/physicalsystems.css"

// Local JPEGs and inert typed IPC only: no LeLab server, camera or motor access.
const images = {
  overview: Uint8Array.from(atob(overview.split(",")[1]), (value) => value.charCodeAt(0)),
  wrist: Uint8Array.from(atob(wrist.split(",")[1]), (value) => value.charCodeAt(0)),
}
const calls: (
  | { type: "discover"; request: LeLabConnection }
  | { type: "frame"; request: LeLabFrameRequest }
  | { type: "stop"; request: { clientId: string } }
)[] = []
const pending: { request: LeLabFrameRequest; resolve(value: LeLabResult<LeLabFrame>): void }[] = []
const objectURLs = new Set<string>()
const decodes: (() => void)[] = []
const createObjectURL = URL.createObjectURL.bind(URL)
const revokeObjectURL = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (blob) => {
  const url = createObjectURL(blob)
  objectURLs.add(url)
  return url
}
URL.revokeObjectURL = (url) => {
  objectURLs.delete(url)
  revokeObjectURL(url)
}
const [state, setState] = createStore({ scope: "project-a/session-a" })
const fixture = {
  calls,
  pending,
  objectURLs,
  decodes,
  multiple: false,
  hold: false,
  holdDecode: false,
  unavailable: false,
  missing: false,
  timestampOffset: 0,
  scope: (scope: string) => setState("scope", scope),
  release: (clientId?: string) => {
    for (const item of pending.splice(0)) {
      if (clientId && item.request.clientId !== clientId) {
        pending.push(item)
        continue
      }
      item.resolve(frame(item.request))
    }
  },
  dispose: () => {},
}
const decode = HTMLImageElement.prototype.decode
HTMLImageElement.prototype.decode = function () {
  return decode.call(this).then(() => {
    if (fixture.holdDecode) return new Promise<void>((resolve) => decodes.push(resolve))
  })
}
function releaseDecodes() {
  for (const resolve of decodes.splice(0)) resolve()
}
function frame(request: LeLabFrameRequest): LeLabResult<LeLabFrame> {
  return {
    ok: true,
    value: {
      bytes: images[request.cameraId.endsWith("overview") ? "overview" : "wrist"],
      contentType: "image/jpeg",
      receivedAt: Date.now() + fixture.timestampOffset,
    },
  }
}
function robot(name: string, prefix: string) {
  return {
    name,
    cameras: ["overview", "wrist"].map((name) => ({
      id: prefix + name,
      name,
      width: 8,
      height: 6,
      fps: 30,
      previewAvailable: true,
    })),
  }
}
const bridge: LeLabCameraBridge = {
  async discover(request) {
    calls.push({ type: "discover", request })
    if (fixture.unavailable) return { ok: false, code: "UNAVAILABLE" }
    return {
      ok: true,
      value: {
        url: request.url,
        robots: fixture.multiple
          ? [robot("White follower", "white-"), robot("Other follower", "other-")]
          : [robot("White follower", "white-")],
      },
    }
  },
  async frame(request) {
    calls.push({ type: "frame", request })
    if (fixture.missing) return { ok: false, code: "CAMERA_MISSING" }
    if (fixture.hold) return new Promise((resolve) => pending.push({ request, resolve }))
    return frame(request)
  },
  async stop(request) {
    calls.push({ type: "stop", request })
  },
}
fixture.dispose = render(
  () => (
    <main class="ps-workspace">
      <div style={{ width: "100%", padding: "12px" }}>
        <p>Synthetic test fixture — local red/blue JPEGs; no camera or robot connected.</p>
        <LeLabCameras bridge={bridge} scope={state.scope} />
      </div>
    </main>
  ),
  document.getElementById("root")!,
)
Object.assign(window, { __lelabFixture: fixture, __releaseLeLabDecodes: releaseDecodes })
