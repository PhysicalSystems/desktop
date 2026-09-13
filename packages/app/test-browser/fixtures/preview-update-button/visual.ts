import "@opencode-ai/ui/styles"
import "./visual.css"
import type { UpdaterState } from "../../../src/updater"
import { mount } from "./entry"

// This page renders production controls with an inert platform bridge. It never
// connects to a Desktop process, downloads an installer, or opens a browser URL.
const root = document.getElementById("root")!
const heading = document.createElement("h1")
heading.textContent = "Physical Systems Desktop"
root.append(heading)
const version = "0.1.0-beta.8"
const examples: { label: string; state: UpdaterState }[] = [
  { label: "Update available", state: { status: "available", mode: "preview", version } },
  { label: "Downloading the update", state: { status: "downloading", mode: "preview", version, percent: 55 } },
  { label: "Ready to install", state: { status: "ready", mode: "preview", version } },
  {
    label: "Previous installation needs a check",
    state: {
      status: "blocked",
      mode: "preview",
      version,
      recoverable: true,
      message: "Check the installed version before continuing.",
    },
  },
  {
    label: "Installation outcome is uncertain",
    state: {
      status: "blocked",
      mode: "preview",
      version,
      message: "The native installation outcome needs confirmation.",
    },
  },
]
for (const example of examples) {
  const row = document.createElement("section")
  const label = document.createElement("p")
  const button = document.createElement("div")
  label.textContent = example.label
  row.append(label, button)
  root.append(row)
  mount(
    button,
    example.state,
    {
      check: async () => example.state,
      download: async () => example.state,
      install: async () => {},
      recover: async () => example.state,
      open: async () => false,
    },
    "linux",
  )
}
const note = document.createElement("footer")
note.textContent = "Rendered UI fixture · native controls are inert"
root.append(note)
document.body.dataset.fixtureReady = "true"
