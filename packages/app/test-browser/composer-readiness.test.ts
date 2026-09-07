import { expect, test } from "bun:test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { composerReadiness, composerSelection } from "../../physicalsystems/src/release/composer-readiness"

test("real V2 composer exposes selected IDs; loading, unknown choices and misleading labels cannot pass readiness", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "composer-readiness-render-"))
  const container = document.createElement("div")
  document.body.append(container)
  let dispose: (() => void) | undefined
  try {
    await build({
      configFile: false,
      root: resolve(import.meta.dir, ".."),
      logLevel: "error",
      plugins: [solid()],
      resolve: { alias: { "@": resolve(import.meta.dir, "../src") } },
      build: {
        target: "esnext",
        outDir: temporary,
        emptyOutDir: true,
        lib: {
          entry: resolve(import.meta.dir, "fixtures/composer-readiness/entry.tsx"),
          formats: ["es"],
          fileName: () => "fixture.mjs",
        },
      },
    })
    const { mount } = await import(pathToFileURL(join(temporary, "fixture.mjs")).href)
    const fixture = mount(container)
    dispose = fixture.dispose
    const c = { id: "conversation", sessionId: "session", serverId: "sidecar" }
    const identity = {
      expectedProjectId: "project",
      snapshot: {
        activeProjectId: "project",
        activeConversationId: c.id,
        conversation: c,
        projects: [{ id: "project", conversations: [c] }],
      },
      routeKeys: ["opencode.desktop.window.fixture.last-active-url"],
      route: "/server/c2lkZWNhcg/session/session",
    }
    const ready = () => composerReadiness({ ...identity, ...composerSelection(container) })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    await settle()
    expect(container.querySelector('[data-component="prompt-input"]')).not.toBeNull()
    // This legacy selector was the cause of the native false negative.
    expect(container.querySelector('[data-action="prompt-agent"] [data-slot="select-select-trigger-value"]')).toBeNull()
    expect(composerSelection(container)).toEqual({
      modelId: "fixture",
      providerId: "fixture",
      agentId: "physical-systems",
    })
    expect(ready()).toBe("READY")
    for (const paid of [false, true]) {
      fixture.update({ paid })
      await settle()
      expect(container.querySelector('[data-action="prompt-model"]')?.getAttribute("data-control-type")).toBe(
        paid ? "popover" : "dialog",
      )
      for (const patch of [
        { loading: true },
        { modelId: "" },
        { modelId: "another-model" },
        { providerId: "another-provider" },
        { agentId: "" },
        { agentId: "unknown" },
        { agentId: "build" },
        { agentVisible: false },
      ]) {
        fixture.update({
          loading: false,
          modelId: "fixture",
          providerId: "fixture",
          agentId: "physical-systems",
          agentVisible: true,
          modelName: "Synthetic workflow fixture",
          agentName: "physical-systems",
          ...patch,
        })
        await settle()
        expect(ready()).toBe("MODEL_NOT_READY")
      }
      fixture.update({ agentId: "physical-systems", agentVisible: true })
      await settle()
      expect(ready()).toBe("READY")
    }
    const duplicate = container.querySelector('[data-action="prompt-agent"]')!.cloneNode(true)
    container.append(duplicate)
    expect(ready()).toBe("MODEL_NOT_READY")
    duplicate.remove()
    expect(
      composerReadiness({ ...identity, route: "/server/c2lkZWNhcg/session/other", ...composerSelection(container) }),
    ).toBe("CONVERSATION_NOT_READY")
  } finally {
    dispose?.()
    container.remove()
    await rm(temporary, { recursive: true, force: true })
  }
}, 30000)
