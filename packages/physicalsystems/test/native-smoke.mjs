// SPDX-License-Identifier: Apache-2.0
// Automated Electron renderer input on an actual display, using an inert local
// provider. No Node profile, device connection, camera or physical execution.
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { startFixtureProvider } from './fixture-provider.mjs'

const evidence = process.argv[2]
if (!evidence) throw new Error('Pass an evidence directory outside the repository')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const root = await mkdtemp(join(resolve(evidence), 'native-review-'))
const configDir = join(root, 'config', 'opencode')
await mkdir(configDir, { recursive: true })
const provider = await startFixtureProvider()
await writeFile(join(configDir, 'opencode.json'), JSON.stringify({
  model: 'fixture/fixture', small_model: 'fixture/fixture', enabled_providers: ['fixture'],
  provider: { fixture: { name: 'Local inert fixture', npm: '@ai-sdk/openai-compatible', api: provider.url,
    options: { baseURL: provider.url, apiKey: 'fixture-not-a-secret' },
    models: { fixture: { name: 'Synthetic workflow fixture', limit: { context: 32000, output: 4096 } } } } },
}))
const executable = process.env.PHYSICALSYSTEMS_TEST_APP || join(repo, 'packages/desktop/node_modules/electron/dist/electron')
const child = spawn(executable, [...(process.env.PHYSICALSYSTEMS_TEST_APP ? [] : ['.']), '--remote-debugging-port=0', `--ozone-platform=${process.env.PHYSICALSYSTEMS_TEST_DISPLAY_BACKEND || 'wayland'}`, '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], {
  cwd: join(repo, 'packages/desktop'), env: { ...process.env,
    PHYSICALSYSTEMS_DATA_DIR: root, PHYSICALSYSTEMS_ALLOW_DEVICES: '0', PHYSICALSYSTEMS_DEBUG_PORT: '0',
    WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    LANG: 'en_US.UTF-8', }, stdio: ['ignore', 'pipe', 'pipe'],
})
const log = createWriteStream(join(root, 'electron.log'))
child.stdout.pipe(log); child.stderr.pipe(log)
const exit = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, label, limit = 60000) {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(150) }
  throw new Error(`Timed out: ${label}`)
}
let socket
let inspectFailure
const checks = []
const startedAt = Date.now()
const timings = []
const passed = (value) => { checks.push(value); timings.push({ check: value, elapsedMs: Date.now() - startedAt }); console.log(JSON.stringify(timings.at(-1))) }
let failed
try {
  const debug = await until(async () => {
    for (const folder of ['session', 'desktop']) {
      const value = await readFile(join(root, folder, 'DevToolsActivePort'), 'utf8').catch(() => '')
      if (value) return Number(value.split('\n')[0])
    }
  }, 'native DevTools port')
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find((target) => target.type === 'page' && target.url.startsWith('oc://renderer/')), 'renderer target')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let id = 0
  const waiting = new Map()
  socket.addEventListener('message', ({ data }) => { const value = JSON.parse(data); const pending = waiting.get(value.id); if (!pending) return; waiting.delete(value.id); value.error ? pending.reject(new Error(value.error.message)) : pending.resolve(value.result) })
  const call = (method, params = {}) => new Promise((resolve, reject) => { const request = ++id; const timer=setTimeout(()=>{waiting.delete(request);reject(new Error(`CDP timeout: ${method}`))},8000); waiting.set(request, { resolve: (result)=>{clearTimeout(timer);resolve(result)}, reject: (error)=>{clearTimeout(timer);reject(error)} }); socket.send(JSON.stringify({ id: request, method, params })) })
  await call("Page.bringToFront")
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  inspectFailure = async () => {
    await writeFile(join(root, "failure-body.txt"), await evaluate("document.body.innerText"))
    const image = await call("Page.captureScreenshot", { format: "png" })
    await writeFile(join(root, "failure-screen.png"), Buffer.from(image.data, "base64"))
  }
  const click = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`)
    await sleep(150)
    const box = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
    if (!box) throw new Error(`Missing clickable element: ${selector}`)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box })
    await sleep(100)
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 })
  }
  await until(() => evaluate('Boolean(document.querySelector("[data-ps-workspace]"))'), 'Physical Systems workspace')
  passed('native Electron workspace loaded')
  await click('[aria-label="New project"]')
  await until(() => evaluate('Boolean(document.querySelector("dialog[open] input"))'), 'project dialog')
  await click('dialog[open] input')
  await call('Input.insertText', { text: 'Synthetic review project' })
  await click('dialog[open] button[type="submit"]')
  await until(() => evaluate('Boolean(document.querySelector("[data-ps-project-row]"))'), 'project created')
  passed('project created through visible UI, simulation profile only')
  await click('[data-ps-project-row]')
  await sleep(400)
  await until(() => evaluate('Boolean(document.querySelector("[data-component=prompt-input]"))'), 'conversation composer')
  const composerStyles = await evaluate(`(() => { const inputs=[...document.querySelectorAll('input[type="file"].hidden')]; return inputs.length > 0 && inputs.every(input => getComputedStyle(input).display === 'none') })()`)
  if (!composerStyles) throw new Error('Physical Systems styles exposed the composer hidden file input')
  passed('operator styles preserve the upstream composer hidden controls')
  await click('[data-component=prompt-input]')
  await call('Input.insertText', { text: 'Find a synthetic alignment approach using three trials.' })
  await sleep(1200)
  await click('button[aria-label="Send"]')
  await until(() => evaluate('Boolean(document.querySelector("[data-ps-approve]"))'), 'inline approval card', 90000)
  passed('real OpenCode agent loop produced inline proposal through fixture provider')
  await until(() => evaluate('document.querySelector(".ps-experiment input[type=checkbox]")?.disabled === false'), 'approval checkbox enabled')
  await click('.ps-experiment input[type="checkbox"]')
  await click('[data-ps-approve]')
  const completed = await until(() => evaluate('window.api.physicalSystems.snapshot().then(s=>s.experiments?.current?.phase === "COMPLETED" ? s.experiments.current : null)'), 'three recorded trials and completion', 90000)
  if (completed.trials.length !== 3 || completed.trials.some((trial) => trial.status !== 'COMPLETED')) throw new Error('Unexpected completed trial evidence')
  passed('Approve & continue durably admitted one continuation; three trials completed')
  await call('Page.reload')
  await until(() => evaluate('Boolean(document.querySelector("[data-ps-workspace]"))'), 'reloaded workspace')
  const persisted = await evaluate('window.api.physicalSystems.snapshot().then(s=>({phase:s.experiments?.current?.phase,trials:s.experiments?.current?.trials?.length,session:s.conversation?.sessionId}))')
  if (persisted.phase !== 'COMPLETED' || persisted.trials !== 3) throw new Error('Reload changed experiment evidence')
  await until(() => evaluate('document.body.innerText.includes("Recorded synthetic result")'), 'visible conversation after reload')
  passed('renderer reload retained session and three trials, without replay')
  const attached = JSON.parse(await readFile(join(root, 'desktop', 'runtime-attach.json'), 'utf8'))
  if (attached.sessionId !== persisted.session) throw new Error('Terminal attachment selected a different conversation')
  const terminal = spawn(join(resolve(evidence), 'toolchain', 'bun'), [join(repo, 'packages/physicalsystems/test/terminal-smoke.ts'), root], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  let terminalOutput = ''
  terminal.stdout.on('data', (chunk) => { terminalOutput += chunk })
  terminal.stderr.on('data', (chunk) => { terminalOutput += chunk })
  const terminalCode = await new Promise((resolve) => terminal.once('exit', resolve))
  await writeFile(join(root, 'terminal-result.log'), terminalOutput)
  if (terminalCode !== 0) throw new Error('Attached terminal client failed; see sanitized terminal result')
  await until(() => evaluate('document.body.innerText.includes("Confirm the recorded synthetic result from this attached terminal.")'), 'terminal message in browser')
  passed('actual command-line client attached to the same session; terminal message appeared in the browser')
  const api = async (path, body) => {
    const response = await fetch(`${attached.url}${path}?directory=${encodeURIComponent(attached.directory)}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Basic ${Buffer.from(`${attached.username}:${attached.password}`).toString('base64')}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) })
    return { status: response.status, text: await response.text() }
  }
  await api(`/session/${persisted.session}/prompt_async`, { agent: 'physical-systems', parts: [{ type: 'text', text: 'Ask the shared fixture question' }] })
  const question = await until(async () => JSON.parse((await api('/question')).text).find((q) => q.sessionID === persisted.session), 'shared pending question')
  await until(() => evaluate('document.body.innerText.includes("Which synthetic check should be recorded?")'), 'question visible in browser')
  const answered = await api(`/question/${question.id}/reply`, { answers: [['Baseline']] })
  if (answered.status >= 300) throw new Error('Shared question answer rejected')
  await until(() => evaluate('document.body.innerText.includes("Shared fixture answer recorded")'), 'shared answer in browser')
  const duplicate = await api(`/question/${question.id}/reply`, { answers: [['Correction']] })
  if (duplicate.status < 400) throw new Error('Settled question accepted a duplicate answer')
  passed('browser displayed a question from another attached client; answer settled once and duplicate answer was rejected')
  await api(`/session/${persisted.session}/prompt_async`, { agent: 'physical-systems', parts: [{ type: 'text', text: 'Wait for fixture cancellation' }] })
  await until(() => provider.calls.some((call) => call.waitingForCancellation), 'pending provider response')
  const aborted = await api(`/session/${persisted.session}/abort`, {})
  if (aborted.status >= 300) throw new Error('Attached-client cancellation rejected')
  await until(async () => { const status = JSON.parse((await api('/session/status')).text)[persisted.session]; return !status || status.type === 'idle' }, 'session idle after cancellation')
  passed('cancellation from attached client settled the shared session without another trial')
  await click('[data-component=prompt-input]')
  await call('Input.insertText', { text: '/model' })
  await until(() => evaluate('document.body.innerText.includes("Select a different model")'), 'model slash command')
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until(() => evaluate('Boolean(document.querySelector("[role=dialog]"))'), 'native model picker')
  passed('/model opened the existing provider/model picker')
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  const image = await call('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, 'completed-synthetic-workflow.png'), Buffer.from(image.data, 'base64'))
  await writeFile(join(root, 'result.json'), JSON.stringify({ checks, timings, completed, persisted, fixtureCalls: provider.calls, simulationOnly: true, opticalFlickerMeasured: false }, null, 2))
} catch (error) {
  failed = error
  await inspectFailure?.().catch(() => {})
  await writeFile(join(root, 'failure.json'), JSON.stringify({ error: error.message, checks, fixtureCalls: provider.calls }, null, 2))
} finally {
  socket?.close()
  // Only the app process started here; no installed service is touched.
  child.kill('SIGTERM')
  await Promise.race([exit, sleep(8000)])
  if (child.exitCode === null && child.signalCode === null) {
    // Never force kill a retained operation. The fixture app can remain for
    // diagnosis; the failure report identifies its isolated data directory.
    console.error('Temporary app retained pending cleanup', { pid: child.pid, root })
    failed ||= new Error('Temporary application cleanup is unconfirmed')
  } else {
    const attachmentRemains = await readFile(join(root, 'desktop', 'runtime-attach.json')).then(() => true, () => false)
    if (attachmentRemains) failed ||= new Error('Attachment credential remained after shutdown')
    else passed('owned Electron app exited and removed its private terminal attachment')
  }
  await provider.close()
}
const summary = { root, checks, timings, result: failed ? 'FAIL' : 'PASS', error: failed?.message }
await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
if (failed) process.exitCode = 1
