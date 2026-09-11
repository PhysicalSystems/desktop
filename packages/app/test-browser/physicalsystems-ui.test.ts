import { expect, test } from "bun:test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { createServer, request } from "node:http"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"

// Actual Solid feature components, a fake IPC bridge, and isolated upstream app
// contexts. No model, provider, Node connection, camera, or hardware is opened.
const enabled = process.env.PHYSICALSYSTEMS_UI_BROWSER_TESTS === "1"
test.skipIf(!enabled)(
  "Physical Systems sidebar, exact approval, and independent Stop",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "ps-solid-ui-"))
    const fixture = resolve(import.meta.dir, "fixtures/physicalsystems")
    const mocks = join(fixture, "mocks.ts")
    const feature = resolve(import.meta.dir, "../src/physicalsystems")
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
    await build({
      configFile: false,
      root: fixture,
      logLevel: "error",
      plugins: [
        {
          name: "physicalsystems-fixture-contexts",
          enforce: "pre",
          resolveId(id, importer) {
            if (importer?.startsWith(feature) && contexts.includes(id)) return mocks
          },
        },
        solid(),
      ],
      build: { outDir: temporary, emptyOutDir: true, sourcemap: true },
    })
    const server = createServer(async (request, response) => {
      const path = request.url === "/" ? "/index.html" : (request.url ?? "")
      if (!/^\/(?:index\.html|assets\/[\w.-]+)$/.test(path)) {
        response.writeHead(404).end()
        return
      }
      const bytes = await readFile(join(temporary, path)).catch(() => undefined)
      if (!bytes) {
        response.writeHead(404).end()
        return
      }
      response.setHeader(
        "Content-Type",
        path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html",
      )
      response.end(bytes)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture port unavailable")
    const reserve = createServer()
    await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve))
    const driverAddress = reserve.address()
    if (!driverAddress || typeof driverAddress === "string") throw new Error("WebDriver port unavailable")
    await new Promise<void>((resolve) => reserve.close(() => resolve()))
    const origin = `http://127.0.0.1:${driverAddress.port}`
    const driver = spawn(
      process.env.PHYSICALSYSTEMS_GECKODRIVER ?? "/snap/bin/geckodriver",
      ["--host", "127.0.0.1", "--port", String(driverAddress.port)],
      { stdio: "ignore", detached: true },
    )
    const session = { id: "" }
    const wd = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
      const result = await new Promise<{ value: { error?: string; message?: string; sessionId?: string } }>(
        (resolve, reject) => {
          const connection = request(
            origin + path,
            { method, headers: { "Content-Type": "application/json" } },
            (response) => {
              const chunks: Buffer[] = []
              response.on("data", (chunk: Buffer) => chunks.push(chunk))
              response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())))
            },
          )
          connection.on("error", reject)
          connection.setTimeout(12000, () => connection.destroy(new Error("WebDriver request timed out")))
          connection.end(body === undefined ? undefined : JSON.stringify(body))
        },
      )
      if (result.value?.error) throw new Error(JSON.stringify(result.value))
      return result.value
    }
    const js = async <T>(script: string, args: unknown[] = []) =>
      wd(`/session/${session.id}/execute/sync`, { script, args }) as Promise<T>
    const until = async (condition: () => Promise<boolean>) => {
      for (const attempt of Array.from({ length: 120 }, (_, index) => index)) {
        if (await condition()) return
        await setTimeout(50)
        if (attempt === 119) throw new Error("Browser condition timed out")
      }
    }
    try {
      await until(() =>
        wd("/status").then(
          () => true,
          () => false,
        ),
      )
      const created = await wd("/session", {
        capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": { args: ["-headless"] } } },
      })
      session.id = created.sessionId!
      await wd(`/session/${session.id}/window/rect`, { width: 1280, height: 900 })
      await wd(`/session/${session.id}/url`, { url: `http://127.0.0.1:${address.port}/` })
      await until(() => js("return !!document.querySelector('[data-ps-project-row]')"))
      await js(`window.__fixture.composerStyles=(name)=>Object.fromEntries(
        Array.from(document.querySelectorAll('[data-fixture-composer="'+name+'"] [data-fixture-control]')).map(element=>{
          const computed=getComputedStyle(element);
          return [element.dataset.fixtureControl,Object.fromEntries(['display','fontFamily','fontSize','lineHeight','padding','marginTop','borderTopWidth','borderRadius','backgroundColor','opacity','cursor','textAlign','resize','minHeight','transitionDuration'].map(key=>[key,computed[key]]))];
        }));`)
      expect(await js("return window.__fixture.composerStyles('inside')")).toEqual(
        await js("return window.__fixture.composerStyles('outside')"),
      )
      const focused = await js(
        `const input=document.querySelector('[data-fixture-composer="inside"] [data-fixture-control="text"]');input.focus();const style=getComputedStyle(input);return [input.matches(':focus-visible'),style.outlineStyle,style.outlineWidth,style.outlineColor,style.outlineOffset]`,
      )
      expect(focused).toEqual(
        await js(
          `const input=document.querySelector('[data-fixture-composer="outside"] [data-fixture-control="text"]');input.focus();const style=getComputedStyle(input);return [input.matches(':focus-visible'),style.outlineStyle,style.outlineWidth,style.outlineColor,style.outlineOffset]`,
        ),
      )
      expect(
        await js(
          "return getComputedStyle(document.querySelector('[data-fixture-composer=inside] input[type=file]')).display",
        ),
      ).toBe("none")
      await js("document.activeElement.blur()")
      expect(await js("return window.__fixture.calls.length")).toBe(0)
      expect(await js("return document.querySelector('.ps-context-connection-label').textContent")).toBe(
        "Synthetic fixture",
      )
      expect(await js("return document.querySelector('[data-ps-connection-kind]').textContent")).toBe("Simulation")
      expect(await js("return document.querySelectorAll('[data-ps-experiment-card] img').length")).toBe(0)
      await js(
        "document.querySelector('[data-ps-project-row=project-a]').dispatchEvent(new PointerEvent('pointerenter',{bubbles:true}))",
      )
      await until(() => js("return !!document.querySelector('[data-ps-project-hover=project-a]')"))
      expect(
        await js(
          "return document.querySelector('[data-ps-project-hover]').textContent.includes('Detected devices: Unverified')",
        ),
      ).toBe(true)
      await js(
        "document.querySelector('[aria-label=\"Keep project details open\"]').click(); document.querySelector('[data-ps-project-row=project-a]').dispatchEvent(new PointerEvent('pointerleave',{bubbles:true}))",
      )
      await setTimeout(350)
      expect(await js("return !!document.querySelector('[data-ps-project-hover]')")).toBe(true)
      await js("document.querySelector('[aria-label=\"Close project details\"]').click()")
      expect(await js("return document.activeElement.dataset.psProjectRow")).toBe("project-a")
      expect(await js("return document.querySelectorAll('[data-ps-project-hover]').length")).toBe(0)
      await js(
        "document.querySelector('[data-ps-project-row=project-a]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
      )
      await js(
        "document.querySelector('[data-ps-project-row=project-b]').dispatchEvent(new PointerEvent('pointerenter',{bubbles:true}))",
      )
      await until(() => js("return !!document.querySelector('[data-ps-project-hover=project-b]')"))
      await js(
        "Array.from(document.querySelectorAll('[data-ps-project-hover] button')).find(x=>x.textContent==='Credentials').click()",
      )
      await until(() => js("return !!document.querySelector('[data-ps-credentials]')"))
      expect(await js("return document.querySelector('[data-ps-credentials]').matches(':modal')")).toBe(false)
      expect(
        await js(
          "return Array.from(document.querySelectorAll('[data-ps-credentials] input')).every(x=>x.type==='password' && x.autocomplete==='off')",
        ),
      ).toBe(true)
      await js(
        "const camera=document.querySelector('[data-ps-camera-token]'); camera.value='synthetic-fixture-token'; camera.dispatchEvent(new InputEvent('input',{bubbles:true})); document.querySelector('[data-ps-credentials] button[type=submit]').click()",
      )
      await until(() => js("return !document.querySelector('[data-ps-credentials]')"))
      expect(await js("return window.__fixture.calls.filter(x=>x.type==='connection.saveCredential').length")).toBe(1)
      expect(await js("return window.__fixture.calls.some(x=>x.type==='connection.connect')")).toBe(false)
      expect(await js("return document.querySelector('[data-ps-approve]').disabled")).toBe(true)
      await js(
        "document.querySelector('[data-ps-experiment-card] input[type=checkbox]').click(); window.__fixture.emit({connectionGeneration:8})",
      )
      expect(await js("return document.querySelector('[data-ps-experiment-card] input[type=checkbox]').checked")).toBe(
        false,
      )
      expect(await js("return document.querySelector('[data-ps-approve]').disabled")).toBe(true)
      await js(
        "const input=document.querySelector('[data-ps-experiment-card] input[type=checkbox]'); input.click(); window.__fixture.hold=true; document.querySelector('[data-ps-approve]').click(); document.querySelector('[data-ps-approve]').click()",
      )
      expect(await js("return window.__fixture.calls.filter(x=>x.type==='experiment.approveAndContinue').length")).toBe(
        1,
      )
      const approved = await js<Record<string, unknown>>(
        "return window.__fixture.calls.find(x=>x.type==='experiment.approveAndContinue')",
      )
      expect(approved).toMatchObject({
        projectId: "project-a",
        conversationId: "conversation-a",
        connectionGeneration: 8,
        experimentId: "experiment-a",
        expectedDigest: "digest-a",
        approved: true,
      })
      expect(typeof approved.requestId).toBe("string")
      await js("window.__fixture.gate(false)")
      await until(() => js("return !!document.getElementById('connection-gate-error')"))
      expect(
        await js(
          "return !!document.querySelector('[data-ps-stop]') && !document.querySelector('[data-ps-stop]').disabled",
        ),
      ).toBe(true)
      await js("document.querySelector('[data-ps-stop]').click()")
      await until(() => js("return window.__fixture.calls.some(x=>x.type==='experiment.stop')"))
      expect(await js("return window.__fixture.calls.find(x=>x.type==='experiment.stop').conversationId")).toBe(
        "conversation-a",
      )
      await js("window.__fixture.release(); window.__fixture.gate(true); window.__fixture.forge(true)")
      await until(() =>
        js("return document.body.textContent.includes('does not match an authoritative experiment record')"),
      )
      expect(await js("return document.querySelectorAll('[data-ps-approve]').length")).toBe(0)
      await js("window.__fixture.forge(false); window.__fixture.emit({closeBlocked:true})")
      await until(() =>
        js("return document.body.textContent.includes('Cleanup is not confirmed. Keep this window open')"),
      )
      await js("document.querySelector('[aria-label=\"Imported history\"]').click()")
      await until(() => js("return !!document.querySelector('.ps-migration')"))
      await js(
        "Array.from(document.querySelectorAll('.ps-migration button')).find(x=>x.textContent.includes('Choose a previous data folder')).click()",
      )
      await until(() => js("return !!document.querySelector('[data-ps-import-preview]')"))
      expect(await js("return window.__fixture.imports.length")).toBe(0)
      await js(
        "Array.from(document.querySelectorAll('[data-ps-import-preview] button')).find(x=>x.textContent.includes('Import this historical copy')).click()",
      )
      await until(() => js("return !!document.querySelector('.ps-migration details summary')"))
      await js("document.querySelector('.ps-migration details summary').click()")
      await until(() => js("return document.querySelector('.ps-migration')?.textContent.includes('APPROVED <img')"))
      expect(await js("return window.__fixture.imports")).toEqual(["trusted-preview-token"])
      expect(
        await js("return document.querySelectorAll('.ps-migration img,.ps-migration [data-ps-approve]').length"),
      ).toBe(0)
      expect(await js("return document.querySelector('.ps-migration textarea').value")).toBe("**Literal saved draft**")
      await js(
        "document.querySelector('[aria-label=\"Close imported history\"]').click(); window.__fixture.gate(false); window.__fixture.emit({hostUnavailable:true}); window.__fixture.recoverReject=true",
      )
      await until(() => js("return !!document.querySelector('[data-ps-recover]')"))
      expect(await js("return window.__fixture.recoverCalls")).toBe(0)
      await js("document.querySelector('[data-ps-recover]').click()")
      await until(() =>
        js(
          "return document.querySelector('[data-ps-operations]').textContent.includes('request could not be confirmed')",
        ),
      )
      expect(await js("return !!document.querySelector('[data-ps-recover]')")).toBe(true)
      await js("window.__fixture.recoverReject=false; document.querySelector('[data-ps-recover]').click()")
      await until(() => js("return !document.querySelector('[data-ps-recover]')"))
      expect(await js("return window.__fixture.recoverCalls")).toBe(2)
      await js("window.__fixture.gate(true)")
      await js(
        "const current=window.__fixture.state.experiments.current; window.__fixture.hold=false; window.__fixture.emit({experiments:{...window.__fixture.state.experiments,current:{...current,phase:'READY'},continuation:{requestId:window.__fixture.calls.find(x=>x.type==='experiment.approveAndContinue').requestId,status:'UNCONFIRMED',experimentId:current.id,planDigest:current.planDigest,checkpoint:'persisted-checkpoint'}}}); window.__fixture.gate(false)",
      )
      await js("window.__fixture.gate(true)")
      await until(() =>
        js("return document.querySelector('[data-ps-continue]')?.textContent.includes('Check continuation')"),
      )
      expect(await js("return window.__fixture.calls.filter(x=>x.type==='experiment.continue').length")).toBe(0)
      await js("document.querySelector('[data-ps-continue]').click()")
      await until(() => js("return window.__fixture.calls.some(x=>x.type==='experiment.continue')"))
      expect(await js("return window.__fixture.calls.find(x=>x.type==='experiment.continue').requestId")).toBe(
        approved.requestId,
      )
      await js(
        "document.querySelector('[data-ps-tab=setup]').click(); document.querySelector('[data-ps-project-row=project-a]').dispatchEvent(new PointerEvent('pointerenter',{bubbles:true}))",
      )
      await until(() => js("return !!document.querySelector('[data-ps-view-devices]')"))
      await js("document.querySelector('[data-ps-view-devices]').click()")
      await until(() =>
        js("return document.querySelector('[data-ps-tab=devices]')?.getAttribute('aria-selected')==='true'"),
      )
      expect(await js("return window.__fixture.sessions.created.length")).toBe(0)
      await js(
        "window.__fixture.state.projects[1].conversations=[]; window.__fixture.emit(); document.querySelector('[data-ps-project-row=project-b]').dispatchEvent(new PointerEvent('pointerenter',{bubbles:true}))",
      )
      await until(() =>
        js("return !!document.querySelector('[data-ps-project-hover=project-b] [data-ps-view-devices]')"),
      )
      await js("document.querySelector('[data-ps-view-devices]').click()")
      await until(() =>
        js(
          "return document.querySelector('[data-ps-panel]')?.textContent.includes('Connect') && window.__fixture.state.activeProjectId==='project-b'",
        ),
      )
      expect(await js("return window.__fixture.sessions.created")).toEqual([
        { agent: "physical-systems", location: { directory: "/fixture/b" } },
      ])
      expect(await js("return window.__fixture.calls.find(x=>x.type==='session.bind')")).toEqual({
        type: "session.bind",
        projectId: "project-b",
        serverId: "sidecar",
        sessionId: "session-created-1",
        title: "Device inspection",
      })
      expect(await js("return window.__fixture.sessions.remembered")).toEqual(["session-created-1"])
      expect(await js("return window.__fixture.pathname()")).toBe("/server/c2lkZWNhcg==/session/session-created-1")
      expect(
        await js(
          "return window.__fixture.calls.some(x=>x.type==='connection.connect'||x.type.startsWith('workcell.'))",
        ),
      ).toBe(false)
      expect(await js("return document.querySelector('.ps-context-connection-label').textContent")).toBe(
        "Unconnected Node",
      )
      await js(
        "window.__fixture.state.projects[1].connection.label='Recovered by another window'; window.__fixture.emit({serviceId:'recovered-service-peer',hostUnavailable:false})",
      )
      await until(() => js("return !!document.querySelector('[data-ps-recover]')"))
      expect(await js("return document.querySelector('.ps-context-connection-label').textContent")).toBe(
        "Unconnected Node",
      )
      expect(await js("return window.__fixture.recoverCalls")).toBe(2)
      await js("document.querySelector('[data-ps-recover]').click()")
      await until(() => js("return !document.querySelector('[data-ps-recover]')"))
      expect(await js("return document.querySelector('.ps-context-connection-label').textContent")).toBe(
        "Recovered by another window",
      )
      expect(await js("return window.__fixture.recoverCalls")).toBe(3)
      // Decode real local JPEG bytes, with controllable completion at the browser's decode boundary.
      await js(`const original=HTMLImageElement.prototype.decode;
        window.__fixture.decode={mode:'normal',held:[]};
        HTMLImageElement.prototype.decode=function(){
          this.dataset.fixtureFrame=window.__fixture.state.commandResult.frame.id;
          const mode=window.__fixture.decode.mode;
          return original.call(this).then(()=>{
            if(mode==='reject') throw new Error('fixture decode rejected');
            if(mode==='hold') return new Promise(resolve=>window.__fixture.decode.held.push(resolve));
          });
        };
        window.__fixture.camera('frame-first',2200)`)
      await until(() => js("return document.querySelector('[data-ps-camera] code')?.textContent==='frame-first'"))
      expect(await js("return document.querySelector('[data-ps-camera] img').naturalWidth")).toBe(2)
      await js("window.__fixture.holdFrame=true;window.__fixture.camera('frame-fetch-delayed')")
      await until(() => js("return !!window.__fixture.releaseFrame"))
      expect(await js("return document.querySelector('[data-ps-camera] code').textContent")).toBe("frame-first")
      await js("window.__fixture.failFrame=true;window.__fixture.releaseFrame()")
      await setTimeout(150)
      expect(await js("return document.querySelector('[data-ps-camera] code').textContent")).toBe("frame-first")
      await js("window.__fixture.holdFrame=false;window.__fixture.failFrame=false")
      await js("window.__fixture.decode.mode='hold'; window.__fixture.camera('frame-slow',8000)")
      await until(() => js("return window.__fixture.decode.held.length===1"))
      expect(
        await js(
          "return [document.querySelector('[data-ps-camera] img').dataset.fixtureFrame,document.querySelector('[data-ps-camera] code').textContent]",
        ),
      ).toEqual(["frame-first", "frame-first"])
      await until(() => js("return !document.querySelector('[data-ps-camera] img')"))
      expect(await js("return document.querySelectorAll('[data-ps-camera] code').length")).toBe(0)
      await js("window.__fixture.decode.mode='normal'; window.__fixture.decode.held[0]()")
      await until(() => js("return document.querySelector('[data-ps-camera] code')?.textContent==='frame-slow'"))
      expect(await js("return document.querySelector('[data-ps-camera] img').dataset.fixtureFrame")).toBe("frame-slow")
      await js("window.__fixture.decode.mode='reject'; window.__fixture.camera('frame-invalid',8000)")
      await until(() =>
        js("return window.__fixture.calls.some(x=>x.type==='workcell.camera.frame'&&x.frameId==='frame-invalid')"),
      )
      await setTimeout(150)
      expect(await js("return document.querySelector('[data-ps-camera] code').textContent")).toBe("frame-slow")
      await js("window.__fixture.decode.mode='hold'; window.__fixture.camera('frame-reused',8000)")
      await until(() => js("return window.__fixture.decode.held.length===2"))
      await js(
        "window.__fixture.decode.mode='normal'; window.__fixture.camera('frame-reused',8000,'camera-b','capture-b')",
      )
      await until(() => js("return document.querySelector('[data-ps-camera] code')?.textContent==='frame-reused'"))
      expect(
        await js(
          "return window.__fixture.calls.filter(x=>x.type==='workcell.camera.frame'&&x.frameId==='frame-reused').length",
        ),
      ).toBe(2)
      const replaced = await js("return document.querySelector('[data-ps-camera] img').src")
      await js("window.__fixture.decode.held[1]()")
      await setTimeout(150)
      expect(await js("return document.querySelector('[data-ps-camera] img').src")).toBe(replaced)
      await js("window.__fixture.state.projects[1].connection.status='offline'; window.__fixture.emit()")
      await until(() => js("return !document.querySelector('[data-ps-camera] img')"))
      await js("window.__fixture.camera('frame-before-stop')")
      await until(() => js("return document.querySelector('[data-ps-camera] code')?.textContent==='frame-before-stop'"))
      await js("document.querySelector('[data-ps-stop^=\"capture:\"]').click()")
      expect(await js("return document.querySelectorAll('[data-ps-camera] img').length")).toBe(0)
      await js("window.__fixture.camera('frame-selection')")
      await until(() => js("return document.querySelector('[data-ps-camera] code')?.textContent==='frame-selection'"))
      await js(
        "const select=document.querySelector('[data-ps-camera] select');select.value='other-camera';select.dispatchEvent(new Event('change',{bubbles:true}))",
      )
      expect(await js("return document.querySelectorAll('[data-ps-camera] img').length")).toBe(0)
      await js(
        "const select=document.querySelector('[data-ps-camera] select');select.value='';select.dispatchEvent(new Event('change',{bubbles:true}));window.__fixture.decode.mode='hold';window.__fixture.camera('frame-deadline',350)",
      )
      await until(() => js("return window.__fixture.decode.held.length===3"))
      await setTimeout(500)
      await js("window.__fixture.decode.mode='normal';window.__fixture.camera('frame-after-deadline')")
      await until(() =>
        js("return document.querySelector('[data-ps-camera] code')?.textContent==='frame-after-deadline'"),
      )
      expect(await js("return document.querySelector('[data-ps-camera] img').dataset.fixtureFrame")).toBe(
        "frame-after-deadline",
      )
      await js("window.__fixture.decode.mode='hold';window.__fixture.camera('frame-late-session')")
      await until(() => js("return window.__fixture.decode.held.length===4"))
      await js(
        "window.__fixture.route('/server/c2lkZWNhcg==/session/session-a');window.__fixture.decode.held[2]();window.__fixture.decode.held[3]()",
      )
      await until(() => js("return window.__fixture.state.activeProjectId==='project-a'"))
      expect(await js("return document.querySelectorAll('[data-ps-camera] img').length")).toBe(0)
      expect(await js("return window.__fixture.errors")).toEqual([])
      // Fresh page: exercise the real browser's commissioning controls with inert IPC.
      await wd(`/session/${session.id}/url`, { url: `http://127.0.0.1:${address.port}/` })
      await until(() => js("return !!document.querySelector('[data-ps-project-row]')"))
      await js(`
        window.__fixture.state.projects[0].connection.status='connected';
        window.__fixture.emit();
        document.querySelector('[data-ps-tab="setup"]').click();
      `)
      expect(await js("return window.__fixture.calls")).toEqual([])
      expect(await js("return document.querySelectorAll('[data-ps-commissioning]').length")).toBe(0)
      expect(await js("return document.querySelectorAll('[role=alert]').length")).toBe(0)
      await js(`
        window.__fixture.state.projects[0].connection.kind='local';
        window.__fixture.state.projects[0].connection.status='connected';
        window.__fixture.emit({activeExperiments:[],workcell:{commissioning:{
          available:true,fresh:true,receivedAt:Date.now(),maximumAgeMs:5000,pending:null,stopPending:false,message:null,
          status:{contractVersion:'physicalsystems-gripper-check-v1',nodeSessionId:'node-a',
            configuration:{id:'gripper-a',digest:'config-a',displayName:'Gripper fixture',deviceIdentity:'fake-robot',
              calibrationDigest:'calibration-a',minimum:20,maximum:60,maximumDelta:5,maximumDurationSeconds:4,
              maximumStep:1,stepIntervalSeconds:0.1,tolerance:0.5},
            inspection:{id:'inspect-a',digest:'inspection-a',observedAt:new Date().toISOString(),
              expiresAt:new Date(Date.now()+30000).toISOString(),ready:true,positions:{gripper:30},
              torqueEnabled:{gripper:false},checks:[],gripperPosition:30},
            trial:{trialId:'trial-a',digest:'plan-a',phase:'WAITING_FOR_APPROVAL',
              approvalExpiresAt:new Date(Date.now()+30000).toISOString(),startPosition:30,targetPosition:33,
              maximumDurationSeconds:4,latestPosition:null,stopStatus:null,message:null},
            canInspect:false,canPrepare:false,canApprove:true,canStop:true,blockedReason:null}
        }}});
        document.querySelector('[data-ps-tab="setup"]').click();
      `)
      await until(() => js("return !!document.querySelector('[data-ps-commissioning-consent]')"))
      expect(await js("return window.__fixture.calls")).toEqual([])
      expect(await js("return document.querySelector('[data-ps-commissioning-approve]').disabled")).toBe(true)
      await js("document.querySelector('[data-ps-commissioning-consent]').click()")
      await until(() => js("return !document.querySelector('[data-ps-commissioning-approve]').disabled"))
      await js("document.querySelector('[data-ps-commissioning-approve]').click()")
      expect(await js("return window.__fixture.calls")).toEqual([
        {
          type: "workcell.commissioning.approve",
          projectId: "project-a",
          conversationId: "conversation-a",
          serverId: "sidecar",
          sessionId: "session-a",
          connectionGeneration: 7,
          trialId: "trial-a",
          trialDigest: "plan-a",
          approved: true,
        },
      ])
      expect(await js("return window.__fixture.errors")).toEqual([])
      await js("document.querySelector('[data-ps-commissioning-trial]').scrollIntoView({block:'center'})")
      if (process.env.PHYSICALSYSTEMS_UI_BROWSER_EVIDENCE) {
        const screenshot = (await wd(`/session/${session.id}/screenshot`)) as unknown as string
        await Bun.write(
          join(process.env.PHYSICALSYSTEMS_UI_BROWSER_EVIDENCE, "solid-ui-fixture.png"),
          Buffer.from(screenshot, "base64"),
        )
      }
    } finally {
      if (session.id) await wd(`/session/${session.id}`, undefined, "DELETE").catch(() => undefined)
      if (driver.pid) process.kill(-driver.pid, "SIGTERM")
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  },
  90000,
)
