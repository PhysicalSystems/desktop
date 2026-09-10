import { afterAll, beforeAll, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { createContext, runInContext } from "node:vm"
import { build, normalizePath } from "vite"
import solid from "vite-plugin-solid"

// Compile real Solid feature components and run their DOM in an isolated VM.
// The fixture supplies IPC/app contexts; no browser, HTTP listener, provider,
// native application, device, or real project directory is started or created.
const require = createRequire(import.meta.url)
const { Window } = await import(createRequire(require.resolve("@happy-dom/global-registrator")).resolve("happy-dom"))
const windows: InstanceType<typeof Window>[] = []
let code = ""

beforeAll(async () => {
  const fixture = resolve(import.meta.dir, "fixtures/physicalsystems")
  const feature = normalizePath(resolve(import.meta.dir, "../src/physicalsystems"))
  const contexts = [
    "../context/language",
    "../context/server",
    "../context/tabs",
    "../context/global",
    "../components/settings-dialog",
    "../utils/persist",
    "../utils/session-route",
    "@solidjs/router",
    "@opencode-ai/session-ui/message-part",
  ]
  const result = await build({
    configFile: false,
    root: fixture,
    logLevel: "error",
    plugins: [
      {
        name: "physicalsystems-project-fixture-contexts",
        enforce: "pre",
        resolveId(id, importer) {
          if (importer && normalizePath(importer).startsWith(feature) && contexts.includes(id))
            return normalizePath(join(fixture, "mocks.ts"))
        },
      },
      solid(),
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: join(fixture, "entry.tsx"),
        output: { format: "iife", name: "PhysicalProjectFixture", inlineDynamicImports: true },
      },
    },
  })
  const output = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk")
  if (!output || output.type !== "chunk") throw new Error("Fixture compilation did not produce JavaScript")
  code = output.code
})

afterAll(async () => {
  await Promise.all(windows.map((window) => window.happyDOM.close()))
})

async function mount(empty = false, failProjectCreate = false) {
  const window = new Window({ url: "http://fixture.invalid" })
  windows.push(window)
  window.__fixtureEmpty = empty
  window.__fixtureFailProjectCreate = failProjectCreate
  window.document.body.innerHTML = '<div id="root"></div>'
  const context = createContext({
    ...Object.fromEntries(
      Object.getOwnPropertyNames(window)
        .filter((key) => key.endsWith("Element"))
        .map((key) => [key, window[key]]),
    ),
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    atob,
    btoa,
    queueMicrotask,
    structuredClone,
  })
  runInContext(code, context)
  await settle()
  return {
    window,
    js<T = unknown>(script: string): T {
      return runInContext(script, context)
    },
  }
}

async function settle() {
  // Flush promise continuations and Solid effects without waiting on fixture
  // polling intervals, which intentionally stay active until DOM disposal.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test("sidebar Settings invokes its app command without changing the managed project", async () => {
  const fixture = await mount()
  let opened = 0
  fixture.window.document.addEventListener("fixture:settings-open", () => opened++)
  fixture.js(`document.querySelector('[data-ps-settings]').click()`)
  await settle()

  expect(opened).toBe(1)
  expect(fixture.js("window.__fixture.calls")).toEqual([])
  expect(fixture.js("window.__fixture.state.activeProjectId")).toBe("project-a")
})

test("creating a project from a linked old chat opens its own conversation without reselecting the old project", async () => {
  const fixture = await mount()
  fixture.js(`
    window.__fixture.holdNavigation=true;
    document.querySelector('.ps-create-project').click();
    const dialog=document.querySelector('[data-ps-project-create]');
    const input=dialog.querySelector('input');
    input.value='Simulation test';
    input.dispatchEvent(new window.Event('input',{bubbles:true}));
    dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  `)
  await settle()
  expect(fixture.js("window.__fixture.calls.map(call => call.type)")).toEqual(["project.create", "session.bind"])
  expect(fixture.js("window.__fixture.sessions.created")).toEqual([
    { agent: "physical-systems", location: { directory: "/fixture/managed/project-created-2" } },
  ])
  expect(fixture.js("window.__fixture.calls[1]")).toMatchObject({
    type: "session.bind",
    projectId: "project-created-2",
    serverId: "sidecar",
    sessionId: "session-created-1",
  })
  expect(fixture.js("window.__fixture.pathname()")).toBe("/server/c2lkZWNhcg==/session/session-a")
  expect(fixture.js("window.__fixture.state.activeProjectId")).toBe("project-created-2")
  fixture.js("window.__fixture.flushNavigation()")
  await settle()
  expect(fixture.js("window.__fixture.calls.map(call => call.type)")).toEqual(["project.create", "session.bind"])
  expect(fixture.js("window.__fixture.pathname()")).toBe("/server/c2lkZWNhcg==/session/session-created-1")
  expect(fixture.window.document.querySelector("[data-ps-project-create]")).toBeNull()
  expect(fixture.js("window.__fixture.errors")).toEqual([])
})

test("new conversation keeps its binding while navigation away from the old linked chat is delayed", async () => {
  const fixture = await mount()
  fixture.js(`window.__fixture.holdNavigation=true; document.querySelector('[data-ps-new-conversation]').click()`)
  await settle()
  expect(fixture.js("window.__fixture.calls.map(call => call.type)")).toEqual(["session.bind"])
  expect(fixture.js("window.__fixture.state.conversation.sessionId")).toBe("session-created-1")
  expect(fixture.js("window.__fixture.pathname()")).toBe("/server/c2lkZWNhcg==/session/session-a")
  fixture.js("window.__fixture.flushNavigation()")
  await settle()
  expect(fixture.js("window.__fixture.calls.map(call => call.type)")).toEqual(["session.bind"])
  expect(fixture.js("window.__fixture.pathname()")).toBe("/server/c2lkZWNhcg==/session/session-created-1")
})

test("an unrelated chat offers a named new conversation instead of a link that will fail", async () => {
  const fixture = await mount()
  fixture.js("window.__fixture.route('/server/c2lkZWNhcg==/session/unrelated', '/fixture/unrelated')")
  expect(fixture.window.document.querySelector("[data-ps-link-conversation]")).toBeNull()
  const recovery = fixture.window.document.querySelector("[data-ps-new-conversation]")
  expect(recovery?.textContent).toContain("New conversation in Alignment lab")
  recovery?.click()
  await settle()
  expect(fixture.js("window.__fixture.sessions.created")).toEqual([
    { agent: "physical-systems", location: { directory: "/fixture/a" } },
  ])
  expect(fixture.js("window.__fixture.calls")).toHaveLength(1)
  expect(fixture.js("window.__fixture.calls[0]")).toMatchObject({
    type: "session.bind",
    projectId: "project-a",
    sessionId: "session-created-1",
  })
  expect(fixture.js("window.__fixture.pathname()")).toBe("/server/c2lkZWNhcg==/session/session-created-1")
})

test("known matching folder preserves manual linking, while unknown metadata does not offer it", async () => {
  const fixture = await mount()
  fixture.js("window.__fixture.route('/server/c2lkZWNhcg==/session/unknown')")
  expect(fixture.window.document.querySelector("[data-ps-link-conversation]")).toBeNull()
  fixture.js("window.__fixture.route('/server/c2lkZWNhcg==/session/same-folder', '/fixture/a/')")
  expect(fixture.window.document.querySelector("[data-ps-link-conversation]")?.textContent).toContain(
    "Link this conversation to Alignment lab",
  )
})

test("a rejected binding keeps the old chat, explains recovery, and reuses the created session on retry", async () => {
  const fixture = await mount()
  fixture.js(`
    window.__fixture.route('/server/c2lkZWNhcg==/session/unrelated', '/fixture/unrelated');
    window.__fixture.failBinding=true;
    document.querySelector('[data-ps-new-conversation]').click();
  `)
  await settle()
  expect(fixture.js("window.__fixture.pathname()")).toBe("/server/c2lkZWNhcg==/session/unrelated")
  expect(fixture.window.document.body.textContent).toContain(
    "This conversation could not be linked to the selected project folder.",
  )
  expect(fixture.window.document.body.textContent).not.toContain("MODEL_SESSION_SCOPE_MISMATCH")
  fixture.js(`window.__fixture.failBinding=false; document.querySelector('[data-ps-new-conversation]').click()`)
  await settle()
  expect(fixture.js("window.__fixture.sessions.created")).toHaveLength(1)
  expect(fixture.js("window.__fixture.calls.filter(call => call.type === 'session.bind')")).toHaveLength(2)
  expect(fixture.js("window.__fixture.pathname()")).toBe("/server/c2lkZWNhcg==/session/session-created-1")
})

test("first launch creates one managed workspace and chat without a folder dialog or duplication on remount", async () => {
  const fixture = await mount(true)
  expect(fixture.js("window.__fixture.calls.map(call => call.type)")).toEqual(["project.create", "session.bind"])
  expect(fixture.js("window.__fixture.calls[0]")).toMatchObject({
    type: "project.create",
    name: "My workspace",
    connection: { type: "simulation" },
  })
  expect(fixture.js("window.__fixture.sessions.created")).toEqual([
    { agent: "physical-systems", location: { directory: "/fixture/managed/project-created-0" } },
  ])
  expect(fixture.js("window.__fixture.pathname()")).toBe("/server/c2lkZWNhcg==/session/session-created-1")
  expect(fixture.window.document.querySelector("[data-ps-project-create]")).toBeNull()
  fixture.js("window.__fixture.gate(false)")
  fixture.js("window.__fixture.gate(true)")
  await settle()
  expect(fixture.js("window.__fixture.calls.map(call => call.type)")).toEqual(["project.create", "session.bind"])
  expect(fixture.js("window.__fixture.sessions.created")).toHaveLength(1)
  expect(fixture.js("window.__fixture.errors")).toEqual([])
})

test("failed first-launch preparation does not automatically retry and can recover through explicit project creation", async () => {
  const fixture = await mount(true, true)
  expect(fixture.js("window.__fixture.calls.map(call => call.type)")).toEqual(["project.create"])
  expect(fixture.js("window.__fixture.sessions.created")).toHaveLength(0)
  expect(fixture.window.document.body.textContent).toContain(
    "Your workspace could not be prepared. Use New project to try again.",
  )
  fixture.js("window.__fixture.emit(); window.__fixture.emit(); window.__fixture.emit()")
  await settle()
  expect(fixture.js("window.__fixture.calls.map(call => call.type)")).toEqual(["project.create"])
  fixture.js(`
    window.__fixture.failProjectCreate=false;
    document.querySelector('.ps-create-project').click();
    const dialog=document.querySelector('[data-ps-project-create]');
    const input=dialog.querySelector('input');
    input.value='Recovered workspace';
    input.dispatchEvent(new window.Event('input',{bubbles:true}));
    dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  `)
  await settle()
  expect(fixture.js("window.__fixture.calls.map(call => call.type)")).toEqual([
    "project.create",
    "project.create",
    "session.bind",
  ])
  expect(fixture.js("window.__fixture.pathname()")).toBe("/server/c2lkZWNhcg==/session/session-created-1")
})
