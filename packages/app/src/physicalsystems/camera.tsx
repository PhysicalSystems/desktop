// SPDX-License-Identifier: Apache-2.0
import { createEffect, onCleanup, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { useLanguage } from "../context/language"
import { usePhysicalSystems } from "./context"
import { cameraFresh, cameraIdentity } from "./state"
import type { PhysicalWorkcell } from "./types"

export function CameraPreview() {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const [state, setState] = createStore({ candidate: "", frameId: "", now: Date.now() })
  const display: {
    element?: HTMLDivElement
    url?: string
    camera?: PhysicalWorkcell["camera"]
    scope?: string
    attempt?: { key: string; cancel: () => void }
    attempted?: string
    disposed: boolean
  } = { disposed: false }
  const camera = () => (physical.bound() ? physical.state.snapshot?.workcell?.camera : undefined)
  const scope = () => JSON.stringify([physical.state.snapshot?.serviceId, physical.scope()])
  const eligible = (value = camera()) =>
    Boolean(
      !physical.state.unavailable &&
        physical.bound() &&
        physical.project()?.connection.status === "connected" &&
        !physical.state.pending[
          `stop:capture:${physical.state.snapshot?.activeProjectId}:${value?.stopCaptureSessionId ?? "pending"}`
        ] &&
        !value?.stopPending &&
        !value?.stopUnconfirmed &&
        cameraFresh(value, Date.now()) &&
        cameraIdentity(value) &&
        (!state.candidate || state.candidate === value?.status?.selectedCandidateId),
    )
  const clear = () => {
    display.element?.replaceChildren()
    if (display.url) URL.revokeObjectURL(display.url)
    display.url = undefined
    display.camera = undefined
    setState("frameId", "")
  }
  const timer = setInterval(() => {
    setState("now", Date.now())
    if (display.camera && (!cameraFresh(display.camera, Date.now()) || !eligible() || display.scope !== scope()))
      clear()
  }, 200)
  onCleanup(() => {
    display.disposed = true
    display.attempt?.cancel()
    clearInterval(timer)
    clear()
  })
  createEffect(() => {
    state.now
    physical.state.snapshot?.revision
    state.candidate
    physical.state.view?.sessionId
    const value = camera()
    if (!value || !eligible(value)) {
      display.attempt?.cancel()
      display.attempted = undefined
      clear()
      return
    }
    if (display.camera && (cameraIdentity(display.camera) !== cameraIdentity(value) || display.scope !== scope()))
      clear()
    const exact = structuredClone(unwrap(value))
    const owner = physical.scope()!
    const identity = cameraIdentity(exact)
    const ownerKey = scope()
    const id = exact.previewFrameId!
    const key = JSON.stringify([ownerKey, identity, id])
    if (display.attempt && display.attempt.key !== key) display.attempt.cancel()
    const requestKey = `frame:${ownerKey}`
    if (
      display.attempt ||
      display.attempted === key ||
      display.camera?.previewFrameId === id ||
      physical.state.pending[requestKey]
    )
      return
    const pending: {
      url?: string
      image?: HTMLImageElement
      timer?: ReturnType<typeof setTimeout>
      resolve?: (value: false) => void
    } = {}
    const aborted = new Promise<false>((resolve) => (pending.resolve = resolve))
    const attempt = {
      key,
      cancel() {
        clearTimeout(pending.timer)
        if (pending.url) URL.revokeObjectURL(pending.url)
        pending.image?.removeAttribute("src")
        pending.url = undefined
        pending.image = undefined
        pending.resolve?.(false)
        if (display.attempt === attempt) display.attempt = undefined
      },
    }
    display.attempt = attempt
    display.attempted = key
    const received = typeof exact.receivedAt === "number" ? exact.receivedAt : Date.parse(exact.receivedAt ?? "")
    // A stalled fetch or decoder cannot keep a candidate alive beyond its original freshness deadline.
    pending.timer = setTimeout(
      attempt.cancel,
      Math.max(0, Math.min(8000, received + exact.status!.staleAfterMs! - exact.status!.frameAgeMs! - Date.now())),
    )
    const valid = () =>
      !display.disposed &&
      display.attempt === attempt &&
      eligible() &&
      scope() === ownerKey &&
      cameraIdentity(camera()) === identity &&
      cameraFresh(exact, Date.now())
    void physical
      .send({ type: "workcell.camera.frame", ...owner, frameId: id }, requestKey)
      .then(async (snapshot) => {
        const frame = snapshot?.commandResult?.frame
        if (
          !frame ||
          !valid() ||
          frame.id !== id ||
          frame.projectId !== owner.projectId ||
          frame.conversationId !== owner.conversationId ||
          frame.serverId !== owner.serverId ||
          frame.sessionId !== owner.sessionId ||
          frame.connectionGeneration !== owner.connectionGeneration ||
          frame.captureSessionId !== exact.frame?.captureSessionId ||
          frame.contentType !== "image/jpeg"
        )
          return
        const url = URL.createObjectURL(new Blob([new Uint8Array(frame.bytes)], { type: "image/jpeg" }))
        pending.url = url
        const image = new Image()
        pending.image = image
        image.alt = language.t("physicalsystems.camera.frame")
        image.src = url
        const decoded = await Promise.race([
          image.decode().then(
            () => true,
            () => false,
          ),
          aborted,
        ])
        if (!decoded || !valid()) return
        const previous = display.url
        // The decoded pixels and their exact frame identity become visible together.
        display.element?.replaceChildren(image)
        display.url = url
        pending.url = undefined
        pending.image = undefined
        display.camera = exact
        display.scope = ownerKey
        setState("frameId", id)
        if (previous) URL.revokeObjectURL(previous)
      })
      .catch(() => undefined)
      .finally(attempt.cancel)
  })
  const start = () => {
    const owner = physical.scope()
    const candidate = camera()?.status?.availableCameras?.find((item) => item.candidateId === state.candidate)
    if (!owner || !candidate || physical.state.unavailable) return
    clear()
    void physical.send({
      type: "workcell.camera.start",
      ...owner,
      candidateId: candidate.candidateId,
      expectedCandidateDigest: candidate.candidateDigest,
    })
  }
  return (
    <section class="ps-card ps-stack" data-ps-camera>
      <h3>{language.t("physicalsystems.camera")}</h3>
      <label>
        {language.t("physicalsystems.camera.select")}
        <select
          value={state.candidate}
          onChange={(event) => {
            clear()
            setState("candidate", event.currentTarget.value)
          }}
        >
          <option value="">{language.t("physicalsystems.camera.select")}</option>
          {camera()?.status?.availableCameras?.map((candidate) => (
            <option value={candidate.candidateId}>{candidate.displayName ?? candidate.candidateId}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={start}
        disabled={
          !physical.bound() ||
          physical.state.unavailable ||
          physical.project()?.connection.status !== "connected" ||
          physical.state.pending.action ||
          Boolean(camera()?.pending) ||
          !state.candidate ||
          Boolean(camera()?.stopCaptureSessionId)
        }
      >
        {language.t("physicalsystems.camera.start")}
      </button>
      <div class="ps-camera-image" ref={(element) => (display.element = element)} />
      <Show
        when={state.frameId}
        fallback={
          <p class="ps-muted">
            {language.t(
              camera()?.status?.captureSessionId ? "physicalsystems.camera.stale" : "physicalsystems.camera.empty",
            )}
          </p>
        }
      >
        <code class="ps-evidence">{state.frameId}</code>
      </Show>
    </section>
  )
}
