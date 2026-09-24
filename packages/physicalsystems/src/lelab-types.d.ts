// SPDX-License-Identifier: Apache-2.0
export type LeLabErrorCode = "INVALID_URL" | "INVALID_REQUEST" | "UNAVAILABLE" | "INVALID_RESPONSE" | "UNSUPPORTED_CAMERA" | "CAMERA_BUSY" | "CAMERA_MISSING" | "CONFIG_CHANGED" | "TIMEOUT" | "CANCELLED" | "CAPACITY"

export type LeLabResult<T> = { ok: true; value: T } | { ok: false; code: LeLabErrorCode }

export type LeLabCamera = { id: string; name: string; width: number; height: number; fps: number; previewAvailable: boolean }
export type LeLabRobot = { name: string; cameras: LeLabCamera[] }
export type LeLabDiscovery = { url: string; robots: LeLabRobot[] }
export type LeLabFrame = { bytes: Uint8Array; contentType: "image/jpeg"; receivedAt: number }
export type LeLabConnection = { url: string; clientId: string }
export type LeLabFrameRequest = LeLabConnection & { robotName: string; cameraId: string }

export type LeLabCameraBridge = {
  discover(request: LeLabConnection): Promise<LeLabResult<LeLabDiscovery>>
  frame(request: LeLabFrameRequest): Promise<LeLabResult<LeLabFrame>>
  /** Cancel only this preview client's requests; never stop a LeLab operation. */
  stop(request: { clientId: string }): Promise<void>
}
