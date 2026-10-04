import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createOpenAILlm } from '@continuum-memory/llm-openai'

describe('provider stream cancellation', () => {
  it('aborts a real local SSE connection instead of only hiding output', async () => {
    let closed!: () => void
    const disconnected = new Promise<void>(resolve => { closed = resolve })
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const send = () => response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '本地测试内容' }, finish_reason: null }] })}\n\n`)
      send()
      const interval = setInterval(send, 25)
      response.on('close', () => { clearInterval(interval); closed() })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local test server did not start')
    const controller = new AbortController()
    try {
      const llm = createOpenAILlm({ apiKey: 'local-fixture-only', baseURL: `http://127.0.0.1:${address.port}/v1` })
      let deltas = 0
      for await (const event of llm.stream('fixture', [{ role: 'user', content: 'test' }], { signal: controller.signal })) {
        if (event.type === 'text-delta') { deltas++; controller.abort() }
      }
      await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error('Provider connection stayed open after abort')), 2000))])
      expect(deltas).toBe(1)
    } finally { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
