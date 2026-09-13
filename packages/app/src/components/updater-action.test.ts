import { describe, expect, test } from "bun:test"
import { updaterAction } from "./updater-action"

describe("updaterAction", () => {
  test("preview Update starts download and verification, while an uncertain installation cannot be retried", () => {
    expect(updaterAction({ status: "available", version: "0.1.0-beta.9", mode: "preview" })).toEqual({
      label: "settings.updates.action.update",
      run: "download",
    })
    expect(
      updaterAction({
        status: "blocked",
        version: "0.1.0-beta.9",
        mode: "preview",
        message: "Installation unconfirmed",
      }),
    ).toEqual({
      label: "settings.updates.action.attention",
    })
  })
  test("disables update actions when the platform has no updater", () => {
    expect(updaterAction(undefined)).toEqual({ label: "settings.updates.action.checkNow" })
  })

  test("projects updater transitions into one settings action", () => {
    expect(updaterAction({ status: "idle" })).toEqual({
      label: "settings.updates.action.checkNow",
      run: "check",
    })
    expect(updaterAction({ status: "checking" })).toEqual({ label: "settings.updates.action.checking" })
    expect(updaterAction({ status: "available", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.download",
      run: "download",
    })
    expect(updaterAction({ status: "downloading", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.downloading",
    })
    expect(updaterAction({ status: "ready", version: "2.0.0" })).toEqual({
      label: "toast.update.action.installRestart",
      run: "install",
    })
    expect(updaterAction({ status: "installing", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.installing",
    })
  })

  test("disabled releases have no action and failed downloads can be checked again", () => {
    expect(updaterAction({ status: "disabled" }).run).toBeUndefined()
    expect(updaterAction({ status: "error", message: "Signature mismatch" }).run).toBe("check")
  })
})
