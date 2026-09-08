// SPDX-License-Identifier: Apache-2.0
// Deliberately inert OpenAI-compatible provider. It tests transport and the real
// OpenCode tool loop; it provides no evidence of model reasoning or robot ability.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

export const qualificationPrompt = 'Find a synthetic alignment approach using three trials.'

export async function startFixtureProvider({ credentialProbe } = {}) {
  const calls = []
  const server = createServer(async (request, response) => {
    const credentialRequest = credentialProbe && request.url === '/credential/v1/chat/completions'
    if (request.method !== 'POST' || (request.url !== '/v1/chat/completions' && !credentialRequest)) { response.writeHead(404).end(); return }
    try {
      const buffers = []
      let bytes = 0
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('FIXTURE_REQUEST_LIMIT'); buffers.push(chunk) }
      const body = JSON.parse(Buffer.concat(buffers))
      const messages = body.messages || []
      const names = new Map(messages.flatMap((message) => (message.tool_calls || []).map((call) => [call.id, call.function.name])))
      const tools = messages.filter((message) => message.role === 'tool').map((message) => ({ name: names.get(message.tool_call_id), text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }))
      const lastUser = messages.findLastIndex((message) => message.role === 'user')
      const requestText = JSON.stringify(messages[lastUser]?.content || '')
      const recent = messages.slice(lastUser + 1).filter((message) => message.role === 'tool')
      const latest = tools.at(-1)
      const parsed = tools.map((tool) => { try { return JSON.parse(tool.text) } catch { return undefined } }).filter(Boolean)
      const current = parsed.map((value) => value.current || value.experiment || (value.id && value.planDigest ? value : null)).filter(Boolean).at(-1)
      let name, args, text
      if (credentialRequest) {
        credentialProbe.observeProviderRequest({ authorization: request.headers.authorization, messages })
        text = 'Inert credential transport observation recorded.'
      }
      else if (!(body.tools || []).some((tool) => tool.function?.name === 'propose_local_experiment')) text = 'Synthetic alignment investigation'
      else if (requestText.includes('Ask the shared fixture question')) {
        if (recent.length === 0) { name = 'question'; args = { questions: [{ header: 'Fixture', question: 'Which synthetic check should be recorded?', options: [{ label: 'Baseline', description: 'Record the baseline choice' }, { label: 'Correction', description: 'Record the correction choice' }] }] } }
        else text = 'Shared fixture answer recorded: **Baseline**.'
      }
      else if (requestText.includes('Wait for fixture cancellation')) {
        calls.push({ tool: null, waitingForCancellation: true })
        // Keep the response open until the real client aborts. No hardware or
        // model request exists behind this deterministic cancellation fixture.
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.flushHeaders()
        return
      }
      else if (recent.length === 0) { name = 'inspect_local_experiment'; args = {} }
      else if (!current) { name = 'propose_local_experiment'; args = { goal: 'Compare a baseline offset with a measured correction and confirmation', mode: 'simulation', trialLimit: 3 } }
      else if (current.phase === 'PROPOSED') text = 'Review this **synthetic experiment** below, then choose **Approve & continue**. Its three trials use arithmetic only.'
      else if (['READY', 'MEASURING', 'RUNNING'].includes(current.phase) && current.trials.length < 3) {
        name = 'run_simulated_trial'; args = { experimentId: current.id, offsetMm: current.trials.length === 0 ? 0 : 3 }
      } else if (current.phase !== 'COMPLETED' && current.phase !== 'FINISHED' && current.trials?.length === 3) { name = 'finish_local_experiment'; args = { experimentId: current.id } }
      else text = '### Recorded synthetic result\n\nThe baseline measured **3 mm error**; the correction and confirmation measured **0 mm error at 3 mm offset**. These are arithmetic fixture results only.'
      calls.push({ credential: Boolean(credentialRequest), tool: name || null, recent: recent.length, phase: current?.phase || null, latest: latest?.name || null,
        syntheticPrompt: requestText.includes(qualificationPrompt) && (body.tools || []).some((tool) => tool.function?.name === 'propose_local_experiment') })
      const message = name ? { role: 'assistant', content: null, tool_calls: [{ id: `fixture_${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: text }
      const base = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: 'fixture', choices: [{ index: 0, message, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }
      if (!body.stream) { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...base, object: 'chat.completion' })); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : { role: 'assistant', content: text }
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
      response.end()
    } catch { response.writeHead(400).end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/v1`, credentialURL: `http://127.0.0.1:${server.address().port}/credential/v1`, calls, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}
