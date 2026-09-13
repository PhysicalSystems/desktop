import type { Accessor } from "solid-js"

export type UpdaterState = (
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "ready"; version: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  | { status: "error"; message: string }
  | { status: "blocked"; version: string; message: string; recoverable?: boolean }
) & { mode?: "preview" }

export type UpdaterPlatform = {
  state: Accessor<UpdaterState>
  check(): Promise<UpdaterState>
  download(): Promise<UpdaterState>
  install(): Promise<void>
  recover?(): Promise<UpdaterState>
}
