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

test("opening simulation Setup never refreshes device commissioning or shows a connection error", async () => {
  const fixture = await mount()
  fixture.js(`
    window.__fixture.state.projects[0].connection.status='connected';
    window.__fixture.emit();
    document.querySelector('[data-ps-tab="setup"]').click();
  `)
  await settle()
  expect(fixture.js("window.__fixture.calls")).toEqual([])
  expect(fixture.window.document.querySelector("[data-ps-commissioning]")).toBeNull()
  expect(fixture.window.document.querySelector('[role="alert"]')).toBeNull()
  fixture.js(`
    document.querySelector('[data-ps-tab="devices"]').click();
    document.querySelector('[data-ps-tab="setup"]').click();
    window.__fixture.emit(); window.__fixture.emit();
  `)
  await settle()
  expect(fixture.js("window.__fixture.calls")).toEqual([])
  expect(fixture.js("window.__fixture.errors")).toEqual([])
  expect(fixture.window.document.querySelector('[role="alert"]')).toBeNull()
})

test.each(["local", "ssh"] as const)(
  "%s Node commissioning refresh waits for connection and permits explicit retry",
  async (kind) => {
    const fixture = await mount()
    fixture.js(`
    window.__fixture.state.projects[0].connection.kind=${JSON.stringify(kind)};
    window.__fixture.emit();
    document.querySelector('[data-ps-tab="setup"]').click();
  `)
    await settle()
    expect(fixture.js("window.__fixture.calls")).toEqual([])
    expect(fixture.js("document.querySelector('[data-ps-commissioning-refresh]').disabled")).toBe(true)
    fixture.js(`
    window.__fixture.state.projects[0].connection.status='connected';
    window.__fixture.emit();
  `)
    await settle()
    expect(fixture.js("window.__fixture.calls.map(x=>x.type)")).toEqual(["workcell.commissioning.refresh"])
    expect(fixture.js("document.querySelector('[data-ps-commissioning-refresh]').disabled")).toBe(false)
    fixture.js("document.querySelector('[data-ps-commissioning-refresh]').click()")
    await settle()
    expect(fixture.js("window.__fixture.calls.map(x=>x.type)")).toEqual([
      "workcell.commissioning.refresh",
      "workcell.commissioning.refresh",
    ])
    expect(fixture.js("window.__fixture.errors")).toEqual([])
  },
)

async function gripperFixture() {
  const fixture = await mount()
  fixture.js(`
    window.__fixture.state.projects[0].connection.kind='local';
    window.__fixture.state.projects[0].connection.status='connected';
    window.__fixture.emit({workcell:{commissioning:{
      available:true,fresh:true,receivedAt:Date.now(),maximumAgeMs:5000,pending:null,stopPending:false,message:null,
      status:{contractVersion:'physicalsystems-gripper-check-v1',nodeSessionId:'node-a',
        configuration:{id:'gripper-a',digest:'config-a',displayName:'Gripper fixture',deviceIdentity:'fake-robot',
          calibrationDigest:'calibration-a',minimum:20,maximum:60,maximumDelta:5,maximumDurationSeconds:4,
          maximumStep:1,stepIntervalSeconds:0.1,tolerance:0.5},
        inspection:{id:'inspect-a',digest:'inspection-a',observedAt:new Date().toISOString(),
          expiresAt:new Date(Date.now()+30000).toISOString(),ready:true,positions:{gripper:30},
          torqueEnabled:{gripper:false},checks:[],gripperPosition:30},trial:null,
        canInspect:true,canPrepare:true,canApprove:false,canStop:false,blockedReason:null}
    }}});
    document.querySelector('[data-ps-tab="setup"]').click();
  `)
  await settle()
  return fixture
}

async function gripperProposal(fixture: Awaited<ReturnType<typeof mount>>) {
  fixture.js(`
    const view=window.__fixture.state.workcell.commissioning;
    view.status.trial={trialId:'trial-a',digest:'plan-a',phase:'WAITING_FOR_APPROVAL',
      approvalExpiresAt:new Date(Date.now()+30000).toISOString(),startPosition:30,targetPosition:33,
      maximumDurationSeconds:4,latestPosition:null,stopStatus:null,message:null};
    view.status.canPrepare=false; view.status.canApprove=true; view.status.canStop=true;
    window.__fixture.emit();
  `)
  await settle()
}

test("gripper Setup does not inspect or move on mount and prepares only a bounded explicit target", async () => {
  const fixture = await gripperFixture()
  expect(fixture.js("window.__fixture.calls")).toEqual([])
  for (const invalid of ["", "70", "36", "30", "30.4"]) {
    fixture.js(`{const input=document.querySelector('[data-ps-commissioning-target]');
      input.value=${JSON.stringify(invalid)};input.dispatchEvent(new window.Event('input',{bubbles:true}));}`)
    await settle()
    expect(fixture.js("document.querySelector('[data-ps-commissioning-prepare]').disabled")).toBe(true)
  }
  fixture.js(`{const input=document.querySelector('[data-ps-commissioning-target]');
    input.value='33';input.dispatchEvent(new window.Event('input',{bubbles:true}));}`)
  await settle()
  expect(fixture.js("document.querySelector('[data-ps-commissioning-prepare]').disabled")).toBe(false)
  fixture.js("document.querySelector('[data-ps-commissioning-prepare]').click()")
  await settle()
  expect(fixture.js("window.__fixture.calls")).toEqual([
    {
      type: "workcell.commissioning.prepare",
      projectId: "project-a",
      conversationId: "conversation-a",
      serverId: "sidecar",
      sessionId: "session-a",
      connectionGeneration: 7,
      configurationDigest: "config-a",
      inspectionDigest: "inspection-a",
      targetPosition: 33,
    },
  ])
})

test("gripper approval resets on plan, Node session, configuration and freshness changes", async () => {
  const fixture = await gripperFixture()
  await gripperProposal(fixture)
  expect(fixture.js("document.querySelector('[data-ps-commissioning-approve]').disabled")).toBe(true)
  for (const change of [
    "view.status.trial.digest='plan-b'",
    "view.status.nodeSessionId='node-b'",
    "view.status.configuration.digest='config-b'",
    "view.receivedAt=Date.now()-6000",
  ]) {
    fixture.js("document.querySelector('[data-ps-commissioning-consent]').click()")
    await settle()
    expect(fixture.js("document.querySelector('[data-ps-commissioning-approve]').disabled")).toBe(false)
    fixture.js(`{const view=window.__fixture.state.workcell.commissioning;${change};window.__fixture.emit()}`)
    await settle()
    expect(fixture.js("document.querySelector('[data-ps-commissioning-consent]').checked")).toBe(false)
    expect(fixture.js("document.querySelector('[data-ps-commissioning-approve]').disabled")).toBe(true)
  }
  expect(fixture.js("window.__fixture.calls")).toEqual([])
  fixture.js(`window.__fixture.state.workcell.commissioning.receivedAt=Date.now();window.__fixture.emit()`)
  await settle()
  fixture.js("document.querySelector('[data-ps-commissioning-consent]').click()")
  await settle()
  fixture.js("document.querySelector('[data-ps-commissioning-approve]').click()")
  await settle()
  expect(fixture.js("window.__fixture.calls")).toEqual([
    {
      type: "workcell.commissioning.approve",
      projectId: "project-a",
      conversationId: "conversation-a",
      serverId: "sidecar",
      sessionId: "session-a",
      connectionGeneration: 7,
      trialId: "trial-a",
      trialDigest: "plan-b",
      approved: true,
    },
  ])
})

test("fresh polling preserves consent for the same exact gripper plan", async () => {
  const fixture = await gripperFixture()
  await gripperProposal(fixture)
  fixture.js("document.querySelector('[data-ps-commissioning-consent]').click()")
  await settle()
  fixture.js("window.__fixture.state.workcell.commissioning.receivedAt=Date.now();window.__fixture.emit()")
  await settle()
  expect(fixture.js("document.querySelector('[data-ps-commissioning-consent]').checked")).toBe(true)
  expect(fixture.js("document.querySelector('[data-ps-commissioning-approve]').disabled")).toBe(false)
  expect(fixture.js("window.__fixture.calls")).toEqual([])
})

test("missing commissioning status requests metadata once and explains absent host configuration", async () => {
  const fixture = await gripperFixture()
  fixture.js("window.__fixture.state.workcell.commissioning.status=null;window.__fixture.emit()")
  await settle()
  fixture.js("window.__fixture.emit();window.__fixture.emit()")
  await settle()
  expect(fixture.js("window.__fixture.calls.map(x=>x.type)")).toEqual(["workcell.commissioning.refresh"])
  fixture.js(`window.__fixture.state.workcell.commissioning.status={
    contractVersion:'physicalsystems-gripper-check-v1',nodeSessionId:'node-a',configuration:null,
    inspection:null,trial:null,canInspect:false,canPrepare:false,canApprove:false,canStop:false,
    blockedReason:'No reviewed gripper configuration is installed on this Node.'};window.__fixture.emit()`)
  await settle()
  expect(fixture.window.document.body.textContent).toContain(
    "No reviewed gripper configuration is installed on this Node.",
  )
  expect(fixture.window.document.querySelector("[data-ps-commissioning-inspect]")).toBeNull()
})

test("confirmed motor stop does not hide an unknown gripper trial outcome", async () => {
  const fixture = await gripperFixture()
  await gripperProposal(fixture)
  fixture.js(`{
    const status=window.__fixture.state.workcell.commissioning.status;
    status.trial.phase='OUTCOME_UNKNOWN';status.trial.stopStatus='STOPPED';
    window.__fixture.emit({activeCommissioning:[{projectId:'project-a',projectName:'First robot',
      conversationId:'conversation-a',serverId:'sidecar',sessionId:'session-a',connectionGeneration:7,
      status,trialId:'trial-a',nodeSessionId:'node-a',canStop:true,stopPending:false}]});
  }`)
  await settle()
  const trial = fixture.window.document.querySelector("[data-ps-commissioning-trial]")!
  expect(trial.textContent).toContain("Outcome unknown")
  expect(trial.textContent).toContain("Stop status")
  expect(trial.textContent).toContain("Stopped")
  expect(
    fixture.js(
      "document.querySelector('[data-ps-stop=\"commissioning:project-a:trial-a\"]').closest('.ps-operation').textContent",
    ),
  ).toContain("Outcome unknown")
  expect(fixture.window.document.querySelector("[data-ps-commissioning-approve]")).toBeNull()
})

test("gripper inspection violations and expired approvals remain blocked", async () => {
  const fixture = await gripperFixture()
  fixture.js(`{
    const view=window.__fixture.state.workcell.commissioning;
    view.status.inspection.ready=false;
    view.status.inspection.checks=[{code:'joint-limit',state:'violated',message:'Elbow outside calibration range'}];
    view.status.canPrepare=false;window.__fixture.emit();
  }`)
  await settle()
  expect(fixture.window.document.body.textContent).toContain("Elbow outside calibration range")
  expect(fixture.js("document.querySelector('[data-ps-commissioning-prepare]').disabled")).toBe(true)
  await gripperProposal(fixture)
  fixture.js(
    `window.__fixture.state.workcell.commissioning.status.trial.approvalExpiresAt=new Date(0).toISOString();window.__fixture.emit()`,
  )
  await settle()
  expect(fixture.js("document.querySelector('[data-ps-commissioning-consent]').disabled")).toBe(true)
  expect(fixture.js("document.querySelector('[data-ps-commissioning-approve]').disabled")).toBe(true)
  expect(fixture.js("window.__fixture.calls")).toEqual([])
})

test("gripper Stop retains original ownership outside the selected conversation and behind its connection gate", async () => {
  const fixture = await gripperFixture()
  await gripperProposal(fixture)
  fixture.js(`{
    const status=window.__fixture.state.workcell.commissioning.status;
    status.trial.phase='OUTCOME_UNKNOWN';status.trial.stopStatus='STOP_UNCONFIRMED';
    window.__fixture.emit({activeCommissioning:[{projectId:'project-a',projectName:'First robot',
      conversationId:'conversation-a',serverId:'sidecar',sessionId:'session-a',connectionGeneration:7,
      status,trialId:'trial-a',nodeSessionId:'node-a',canStop:true,stopPending:false}],
      activeProjectId:'project-b',activeConversationId:'conversation-b',connectionGeneration:9,
      conversation:window.__fixture.state.projects[1].conversations[0],workcell:null});
    window.__fixture.gate(false);
  }`)
  await settle()
  expect(fixture.js("!!document.querySelector('[data-ps-stop=\"commissioning:project-a:trial-a\"]')")).toBe(true)
  fixture.js("document.querySelector('[data-ps-stop=\"commissioning:project-a:trial-a\"]').click()")
  await settle()
  expect(fixture.js("window.__fixture.calls.filter(x=>x.type==='workcell.commissioning.stop')")).toEqual([
    {
      type: "workcell.commissioning.stop",
      projectId: "project-a",
      conversationId: "conversation-a",
      serverId: "sidecar",
      sessionId: "session-a",
      connectionGeneration: 7,
      trialId: "trial-a",
      reason: "operator-requested-stop",
    },
  ])
})

async function recoveryFixture() {
  const fixture = await gripperFixture()
  await gripperProposal(fixture)
  fixture.js(`{
    const view=window.__fixture.state.workcell.commissioning;
    view.unresolved=true;
    view.status.trial.phase='OUTCOME_UNKNOWN';view.status.trial.stopStatus='STOPPED';
    view.status.trialNodeSessionId='node-a';view.status.canInspect=false;
    view.status.canPrepare=false;view.status.canApprove=false;view.status.canInspectRecovery=true;
    window.__fixture.emit({activeCommissioning:[{projectId:'project-a',projectName:'First robot',
      conversationId:'conversation-a',serverId:'sidecar',sessionId:'session-a',connectionGeneration:7,
      status:view.status,trialId:'trial-a',nodeSessionId:'node-a',canStop:true,stopPending:false}]});
  }`)
  await settle()
  return fixture
}

async function recoveryOffer(fixture: Awaited<ReturnType<typeof mount>>) {
  fixture.js(`{
    const view=window.__fixture.state.workcell.commissioning;
    view.recoveryAvailable=true;view.recoveryFresh=true;view.recoveryReceivedAt=Date.now();
    view.recoveryStatus=JSON.parse(JSON.stringify(view.status));
    view.recoveryStatus.nodeSessionId='node-b';view.recoveryStatus.canConfirmRecovery=true;
    view.recoveryStatus.recovery={id:'recovery-a',digest:'recovery-digest-a',trialId:'trial-a',
      trialDigest:'plan-a',trialNodeSessionId:'node-a',nodeSessionId:'node-b',configurationDigest:'config-a',
      deviceIdentity:'fake-robot',observedAt:new Date().toISOString(),
      expiresAt:new Date(Date.now()+30000).toISOString(),ready:true,positions:{gripper:30},
      torqueEnabled:{gripper:false},checks:[{code:'torque-off',state:'met',message:'Every motor is stopped.'}]};
    window.__fixture.emit();
  }`)
  await settle()
}

test("reviewing an unknown gripper trial opens no device and requests only an explicit recovery inspection", async () => {
  const fixture = await recoveryFixture()
  fixture.js("document.querySelector('[data-ps-recovery-review]').click()")
  await settle()
  expect(fixture.js("window.__fixture.calls")).toEqual([])
  expect(fixture.window.document.querySelector("[data-ps-commissioning-trial]")?.textContent).toContain(
    "Outcome unknown",
  )
  expect(fixture.window.document.querySelector("[data-ps-commissioning-trial]")?.textContent).toContain("Stopped")
  fixture.js(`{
    const view=window.__fixture.state.workcell.commissioning;
    view.available=false;view.fresh=false;view.receivedAt=null;
    window.__fixture.emit();
  }`)
  await settle()
  expect(fixture.js("document.querySelector('[data-ps-recovery-inspect]').disabled")).toBe(false)
  fixture.js("document.querySelector('[data-ps-recovery-inspect]').click()")
  await settle()
  expect(fixture.js("window.__fixture.calls")).toEqual([
    {
      type: "workcell.commissioning.recoveryInspect",
      projectId: "project-a",
      conversationId: "conversation-a",
      serverId: "sidecar",
      sessionId: "session-a",
      connectionGeneration: 7,
      trialId: "trial-a",
      trialDigest: "plan-a",
    },
  ])
})

test("recovery confirmation requires exact consent and never prepares or approves a new gripper trial", async () => {
  const fixture = await recoveryFixture()
  fixture.js("document.querySelector('[data-ps-recovery-review]').click()")
  await recoveryOffer(fixture)
  expect(fixture.js("document.querySelector('[data-ps-recovery-confirm]').disabled")).toBe(true)
  expect(fixture.js("window.__fixture.calls")).toEqual([])
  fixture.js("document.querySelector('[data-ps-recovery-consent]').click()")
  await settle()
  expect(fixture.js("document.querySelector('[data-ps-recovery-confirm]').disabled")).toBe(false)
  fixture.js("document.querySelector('[data-ps-recovery-confirm]').click()")
  await settle()
  expect(fixture.js("window.__fixture.calls")).toEqual([
    {
      type: "workcell.commissioning.recoveryConfirm",
      projectId: "project-a",
      conversationId: "conversation-a",
      serverId: "sidecar",
      sessionId: "session-a",
      connectionGeneration: 7,
      trialId: "trial-a",
      trialDigest: "plan-a",
      recoveryDigest: "recovery-digest-a",
      confirmed: true,
    },
  ])
})

test("recovery consent resets for changed evidence or owner and ordinary polling cannot renew it", async () => {
  const fixture = await recoveryFixture()
  fixture.js("document.querySelector('[data-ps-recovery-review]').click()")
  for (const change of [
    "view.recoveryStatus.recovery.digest='another-recovery'",
    "view.recoveryStatus.recovery.trialDigest='another-trial'",
    "view.recoveryStatus.recovery.trialNodeSessionId='another-origin'",
    "view.recoveryStatus.nodeSessionId='another-node-session'",
    "view.recoveryStatus.configuration.digest='another-configuration'",
    "view.recoveryStatus.configuration.deviceIdentity='another-robot'",
    "view.recoveryAvailable=false",
    "view.recoveryFresh=false",
    "view.recoveryReceivedAt=Date.now()-6000;view.receivedAt=Date.now();view.fresh=true",
    "view.recoveryStatus.recovery.expiresAt=new Date(0).toISOString()",
  ]) {
    await recoveryOffer(fixture)
    fixture.js("document.querySelector('[data-ps-recovery-consent]').click()")
    await settle()
    expect(fixture.js("document.querySelector('[data-ps-recovery-confirm]').disabled")).toBe(false)
    fixture.js(`{const view=window.__fixture.state.workcell.commissioning;${change};window.__fixture.emit()}`)
    await settle()
    expect(fixture.js("document.querySelector('[data-ps-recovery-consent]')?.checked ?? false")).toBe(false)
    expect(fixture.js("document.querySelector('[data-ps-recovery-confirm]')?.disabled ?? true")).toBe(true)
    if (change.includes("recoveryReceivedAt"))
      expect(fixture.window.document.body.textContent).toContain("Recovery status is no longer current.")
  }
  expect(fixture.js("window.__fixture.calls")).toEqual([])
})

test("fresh recovery polling preserves exact consent while disconnected or blocked recovery cannot confirm", async () => {
  const fixture = await recoveryFixture()
  fixture.js("document.querySelector('[data-ps-recovery-review]').click()")
  await recoveryOffer(fixture)
  fixture.js("document.querySelector('[data-ps-recovery-consent]').click()")
  await settle()
  fixture.js("window.__fixture.state.workcell.commissioning.recoveryReceivedAt=Date.now();window.__fixture.emit()")
  await settle()
  expect(fixture.js("document.querySelector('[data-ps-recovery-consent]').checked")).toBe(true)
  fixture.js("window.__fixture.state.workcell.commissioning.pending='recoveryInspect';window.__fixture.emit()")
  await settle()
  expect(fixture.window.document.querySelector("[data-ps-recovery-inspect]")?.textContent).toContain(
    "Checking robot state",
  )
  expect(fixture.js("document.querySelector('[data-ps-recovery-confirm]').disabled")).toBe(true)
  expect(fixture.js("document.querySelector('[data-ps-stop=\"commissioning:project-a:trial-a\"]').disabled")).toBe(
    false,
  )
  fixture.js(`{
    const view=window.__fixture.state.workcell.commissioning;
    view.pending=null;
    view.recoveryStatus.recovery.ready=false;
    view.recoveryStatus.recovery.checks=[{code:'worker',state:'violated',message:'The previous worker has not settled.'}];
    window.__fixture.emit();
  }`)
  await settle()
  expect(fixture.window.document.body.textContent).toContain("The previous worker has not settled.")
  expect(fixture.js("document.querySelector('[data-ps-recovery-confirm]').disabled")).toBe(true)
  await recoveryOffer(fixture)
  fixture.js("window.__fixture.state.projects[0].connection.status='offline';window.__fixture.emit()")
  await settle()
  expect(fixture.js("document.querySelector('[data-ps-recovery-inspect]').disabled")).toBe(true)
  expect(fixture.js("document.querySelector('[data-ps-recovery-confirm]').disabled")).toBe(true)
  expect(fixture.js("document.querySelector('[data-ps-stop=\"commissioning:project-a:trial-a\"]').disabled")).toBe(
    false,
  )
  fixture.js("window.__fixture.state.projects[0].connection.kind='simulation';window.__fixture.emit()")
  await settle()
  expect(fixture.window.document.querySelector("[data-ps-commissioning-recovery]")).toBeNull()
  expect(fixture.window.document.querySelector('[data-ps-stop="commissioning:project-a:trial-a"]')).not.toBeNull()
  expect(fixture.js("window.__fixture.calls")).toEqual([])
})

test("recovery consent cannot follow a changed connection generation or another conversation", async () => {
  const fixture = await recoveryFixture()
  fixture.js("document.querySelector('[data-ps-recovery-review]').click()")
  await recoveryOffer(fixture)
  fixture.js("document.querySelector('[data-ps-recovery-consent]').click()")
  await settle()
  fixture.js("window.__fixture.emit({connectionGeneration:8})")
  await settle()
  expect(fixture.window.document.querySelector("[data-ps-recovery-confirm]")).toBeNull()
  fixture.js("document.querySelector('[data-ps-recovery-review]').click()")
  await settle()
  expect(fixture.js("document.querySelector('[data-ps-recovery-consent]').checked")).toBe(false)
  fixture.js("document.querySelector('[data-ps-recovery-consent]').click()")
  await settle()
  fixture.js("window.__fixture.route('/server/c2lkZWNhcg==/session/session-b')")
  await settle()
  expect(fixture.window.document.querySelector("[data-ps-recovery-confirm]")).toBeNull()
  expect(fixture.window.document.querySelector('[data-ps-stop="commissioning:project-a:trial-a"]')).not.toBeNull()
  expect(fixture.js("window.__fixture.calls.filter(x=>x.type.startsWith('workcell.commissioning.'))")).toEqual([])
})

test("verified recovery is separate from the historical unknown result and cannot authorize another trial", async () => {
  const fixture = await recoveryFixture()
  await recoveryOffer(fixture)
  fixture.js(`{
    const view=window.__fixture.state.workcell.commissioning;
    view.recoveryStatus.recoveryClearance={id:'clearance-a',digest:'clearance-digest-a',trialId:'trial-a',
      trialDigest:'plan-a',trialNodeSessionId:'node-a',nodeSessionId:'prior-confirmation-session',
      configurationDigest:'config-a',deviceIdentity:'fake-robot',recoveryDigest:'recovery-digest-a',
      confirmedAt:new Date().toISOString(),inspectionDigest:'fresh-check-a',priorRunDigest:'run-digest-a',priorRevision:7};
    window.__fixture.emit();
  }`)
  await settle()
  expect(fixture.window.document.querySelector("[data-ps-recovery-review]")).not.toBeNull()
  expect(fixture.window.document.querySelector('[data-ps-stop="commissioning:project-a:trial-a"]')).not.toBeNull()
  fixture.js(`{
    const view=window.__fixture.state.workcell.commissioning;
    view.unresolved=false;view.status.canInspect=true;view.status.inspection=null;
    window.__fixture.emit({activeCommissioning:[]});
  }`)
  await settle()
  expect(fixture.window.document.querySelector("[data-ps-recovery-receipt]")?.textContent).toContain(
    "Recovery completed",
  )
  expect(fixture.window.document.querySelector("[data-ps-commissioning-trial]")?.textContent).toContain(
    "Outcome unknown",
  )
  expect(fixture.window.document.querySelector("[data-ps-recovery-confirm]")).toBeNull()
  expect(fixture.js("document.querySelector('[data-ps-commissioning-prepare]').disabled")).toBe(true)
  expect(fixture.js("window.__fixture.calls")).toEqual([])
  fixture.js(`{
    const view=window.__fixture.state.workcell.commissioning;
    view.status.recoveryClearance=view.recoveryStatus.recoveryClearance;
    view.status.trial={...view.status.trial,trialId:'trial-new',digest:'new-plan',
      phase:'WAITING_FOR_APPROVAL',stopStatus:null,approvalExpiresAt:new Date(Date.now()+30000).toISOString()};
    view.status.canApprove=true;window.__fixture.emit();
  }`)
  await settle()
  expect(fixture.window.document.querySelector("[data-ps-recovery-receipt]")?.textContent).toContain(
    "Previous recovery",
  )
  expect(fixture.window.document.querySelector("[data-ps-recovery-receipt]")?.textContent).toContain("trial-a")
  expect(fixture.window.document.querySelector("[data-ps-recovery-review]")).toBeNull()
  expect(fixture.window.document.querySelector("[data-ps-recovery-inspect]")).toBeNull()
  expect(fixture.js("document.querySelector('[data-ps-commissioning-consent]').checked")).toBe(false)
  expect(fixture.js("document.querySelector('[data-ps-commissioning-approve]').disabled")).toBe(true)
  expect(fixture.js("window.__fixture.calls")).toEqual([])
})

test("a retained interrupted owner can review recovery after restart without a live workcell", async () => {
  const fixture = await recoveryFixture()
  fixture.js(`{
    const view=window.__fixture.state.workcell.commissioning;
    view.status.trial.phase='RUNNING';view.status.trial.stopStatus='STOP_UNCONFIRMED';
    view.message='The previous Node session is unavailable.';
    const owner=window.__fixture.state.activeCommissioning[0];
    owner.statusUnavailable=true;owner.recoveryView=view;
    window.__fixture.emit({workcell:null});
  }`)
  await settle()
  expect(fixture.window.document.querySelector("[data-ps-commissioning-trial]")?.textContent).toContain("Running")
  expect(fixture.window.document.querySelector("[data-ps-recovery-review]")?.textContent).toContain(
    "Review interrupted trial",
  )
  expect(fixture.js("document.querySelector('[data-ps-commissioning-refresh]').disabled")).toBe(true)
  fixture.js("document.querySelector('[data-ps-recovery-review]').click()")
  await settle()
  expect(fixture.window.document.body.textContent).toContain("The previous Node session is unavailable.")
  expect(fixture.js("window.__fixture.calls")).toEqual([])
  fixture.js("document.querySelector('[data-ps-recovery-inspect]').click()")
  await settle()
  expect(fixture.js("window.__fixture.calls.map(x=>x.type)")).toEqual(["workcell.commissioning.recoveryInspect"])
  expect(fixture.window.document.querySelector('[data-ps-stop="commissioning:project-a:trial-a"]')).not.toBeNull()
})
