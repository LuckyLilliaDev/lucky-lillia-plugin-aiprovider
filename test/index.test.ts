import { createServer, AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from '@luckylillia/plugin-sdk/testing'
import * as Provider from '../src/index.js'
import { AiProviderService } from '../src/provider.js'
import type { AiError } from '../src/types.js'
import { ProxyAgent } from 'undici'
import { completion, FakeAnswer, FakeCall, PNG, startConnectProxy, startFakeAi } from './fakeAi.js'

let app: TestApp
let fake: Awaited<ReturnType<typeof startFakeAi>>
let answer: (call: FakeCall) => FakeAnswer | undefined

const ai = (name: string, extra: Partial<Provider.AiConfig> = {}): Partial<Provider.AiConfig> => ({
  name,
  baseUrl: `${fake.url}/v1`,
  apiKey: `key-${name}`,
  models: [`${name}-model`],
  ...extra,
})

async function mount(config: Partial<Provider.Config>) {
  const fiber = await app.ctx.plugin(Provider, config)
  await vi.waitFor(() => expect(app.ctx.get('ai')).toBeTruthy())
  return fiber
}

async function webui(method: string, path: string, body?: unknown) {
  const provider = app.ctx.get('ai') as AiProviderService
  const response = await Provider.handle(provider, new Request(`http://bot/api/aiprovider${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
  }))
  return { status: response.status, ...await response.json() as { success: boolean; data?: any; message?: string; kind?: string } }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

const failure = (promise: Promise<unknown>) => promise.then(() => {
  throw new Error('expected a failure')
}, (e: AiError) => e)

const piece = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] })

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const pieces: string[] = []
  for await (const item of stream) pieces.push(item)
  return pieces
}

beforeEach(async () => {
  answer = call => (call.path === '/v1/chat/completions' ? { json: completion('好的', call.json?.model) } : undefined)
  fake = await startFakeAi(call => answer(call))
  app = await createTestApp()
})

afterEach(async () => {
  await app.dispose()
  await fake.close()
})

describe('the AI provider', () => {
  it('asks the AI named, or the default one, with its key, model and extra fields', async () => {
    await mount({
      ais: [
        ai('a', { baseUrl: `${fake.url}/v1/chat/completions/`, headers: { 'x-test': '1' }, body: { enable_thinking: false } }),
        ai('b'),
      ],
      default: 'b',
    })
    const result = await app.ctx.ai.chat('你好')
    expect(result).toEqual({
      text: '好的', ai: 'b', model: 'b-model', usage: { input: 12, output: 3 }, finishReason: 'stop', raw: completion('好的', 'b-model'),
    })
    expect(fake.calls[0].headers.authorization).toBe('Bearer key-b')
    expect(fake.calls[0].json).toEqual({ model: 'b-model', messages: [{ role: 'user', content: '你好' }] })

    await app.ctx.ai.chat([{ role: 'system', content: '简短' }, { role: 'user', content: '你好' }], { ai: 'a', model: 'other', temperature: 0, maxTokens: 5 })
    expect(fake.calls[1].path).toBe('/v1/chat/completions')
    expect(fake.calls[1].headers).toMatchObject({ authorization: 'Bearer key-a', 'x-test': '1' })
    expect(fake.calls[1].json).toEqual({
      enable_thinking: false,
      model: 'other',
      messages: [{ role: 'system', content: '简短' }, { role: 'user', content: '你好' }],
      temperature: 0,
      max_tokens: 5,
    })
    expect(app.ctx.ai.list()).toEqual([
      { name: 'a', models: ['a-model'], model: 'a-model', proxy: true },
      { name: 'b', models: ['b-model'], model: 'b-model', proxy: true },
    ])
    expect(app.ctx.ai.get()?.name).toBe('b')
  })

  it('recognizes normalized official OpenAI endpoints in list and get without exposing settings', async () => {
    const endpoints = [
      'https://api.openai.com/v1',
      'https://api.openai.com/v1/',
      'https://api.openai.com/v1///',
      'https://api.openai.com/v1/chat/completions/',
      'HTTPS://API.OPENAI.COM/v1',
      'https://api.openai.com:443/v1',
    ]
    await mount({ ais: endpoints.map((baseUrl, index) => ai(`endpoint-${index}`, {
      baseUrl, apiKey: 'private-key', headers: { 'x-secret': 'private-header' }, models: [],
    })) })
    const listed = app.ctx.ai.list()
    endpoints.forEach((_, index) => {
      const expected = { name: `endpoint-${index}`, models: [], model: '', proxy: true, provider: 'openai' }
      expect(listed[index]).toEqual(expected)
      expect(app.ctx.ai.get(expected.name)).toEqual(expected)
    })
    expect(app.ctx.ai.get()).toEqual(listed[0])
    expect(fake.calls).toHaveLength(0)
  })

  it('omits provider for names, models, lookalike hosts and noncanonical OpenAI API addresses', async () => {
    const endpoints = [
      `${fake.url}/v1`,
      'https://api.deepseek.com/v1',
      'https://api.openai.com.example/v1',
      'https://proxy.api.openai.com/v1',
      'https://openai.com/v1',
      'https://api.openai.com./v1',
      'https://%61pi.openai.com/v1',
      'http://api.openai.com/v1',
      'https://api.openai.com:8443/v1',
      'https://user:password@api.openai.com/v1',
      'https://@api.openai.com/v1',
      'https://api.openai.com@elsewhere.example/v1',
      'https://api.openai.com/v1?key=value',
      'https://api.openai.com/v1?',
      'https://api.openai.com/v1#fragment',
      'https://api.openai.com/v1#',
      'https://api.openai.com/proxy/v1',
      'https://api.openai.com/v1/proxy',
      'https://api.openai.com/proxy/../v1',
      'https://api.openai.com/V1',
      'https://api.openai.com/',
    ]
    await mount({ ais: endpoints.map((baseUrl, index) => ai(`OpenAI ${index}`, { baseUrl, models: ['gpt-4o'] })) })
    const listed = app.ctx.ai.list()
    endpoints.forEach((_, index) => {
      const expected = { name: `OpenAI ${index}`, models: ['gpt-4o'], model: 'gpt-4o', proxy: true }
      expect(listed[index]).toEqual(expected)
      expect(listed[index]).not.toHaveProperty('provider')
      expect(app.ctx.ai.get(expected.name)).toEqual(expected)
      expect(app.ctx.ai.get(expected.name)).not.toHaveProperty('provider')
    })
    expect(fake.calls).toHaveLength(0)
  })

  it('updates provider metadata when the configured endpoint changes without probing it', async () => {
    const official = ai('selected', { baseUrl: 'https://api.openai.com/v1' })
    const fiber = await mount({ ais: [official] })
    expect(app.ctx.ai.get()?.provider).toBe('openai')
    await fiber.update({ ais: [ai('selected')] })
    expect(app.ctx.ai.get()).not.toHaveProperty('provider')
    expect(app.ctx.ai.list()[0]).not.toHaveProperty('provider')
    await fiber.update({ ais: [official] })
    expect(app.ctx.ai.get()?.provider).toBe('openai')
    expect(app.ctx.ai.list()[0].provider).toBe('openai')
    expect(fake.calls).toHaveLength(0)
  })

  it('sends images as data URLs, typed by their bytes', async () => {
    await mount({ ais: [ai('v')] })
    await app.ctx.ai.chat([{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', data: PNG }, { type: 'image', url: 'https://x/y.jpg' }] }])
    expect(fake.calls[0].json.messages[0].content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
      { type: 'image_url', image_url: { url: 'https://x/y.jpg' } },
    ])
  })

  it('keeps old model settings until an explicit model list replaces them, and ignores vision flags', async () => {
    const legacy = { name: 'old', baseUrl: `${fake.url}/v1`, model: ' old-model ', vision: true }
    expect(Provider.Config({ ais: [legacy] } as never).ais[0].models).toBeUndefined()
    await mount({ ais: [legacy, ai('cleared', { model: 'retired-model', models: [] })] })
    expect(app.ctx.ai.list()).toEqual([
      { name: 'old', models: ['old-model'], model: 'old-model', proxy: true },
      { name: 'cleared', models: [], model: '', proxy: true },
    ])
    expect(await app.ctx.ai.chat('x')).toMatchObject({ model: 'old-model' })
    expect(await failure(app.ctx.ai.chat('x', { ai: 'cleared' }))).toMatchObject({ kind: 'config', message: expect.stringContaining('没有可用模型') })
  })

  it('lets each caller choose an endpoint and model, including matching model IDs on different endpoints', async () => {
    await mount({ ais: [ai('a', { models: [' shared ', ' shared', '', 'second'] }), ai('b', { models: ['shared'] })] })
    expect(app.ctx.ai.get('a')?.models).toEqual(['shared', 'second'])
    const publicInfo = app.ctx.ai.get('a')!
    publicInfo.models.push('modified')
    expect(app.ctx.ai.get('a')?.models).toEqual(['shared', 'second'])
    await app.ctx.ai.chat('first', { ai: 'a', model: 'shared' })
    await app.ctx.ai.chat('second', { ai: 'b', model: 'shared' })
    await app.ctx.ai.chat('third', { ai: 'a', model: ' second ' })
    expect(fake.calls.map(call => [call.headers.authorization, call.json.model])).toEqual([
      ['Bearer key-a', 'shared'], ['Bearer key-b', 'shared'], ['Bearer key-a', 'second'],
    ])
  })

  it('allows an empty model list for other API calls and an explicitly chosen chat model', async () => {
    await mount({ ais: [ai('a', { models: [] })] })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'config' })
    expect(fake.calls).toHaveLength(0)
    expect(await app.ctx.ai.chat('x', { model: 'caller-model' })).toMatchObject({ model: 'caller-model' })
    answer = () => ({ json: { data: [] } })
    expect(await (await app.ctx.ai.request('a', '/models')).json()).toEqual({ data: [] })
  })

  it('tests the current draft while live callers keep their saved settings and statistics', async () => {
    await mount({ ais: [ai('saved')] })
    const connections: { proxyAgent?: string }[] = []
    app.ctx.on('http/fetch-init', (_url, _init, config) => { connections.push({ proxyAgent: config.proxyAgent }) })
    answer = call => ({ json: completion('好的', call.json?.model), delay: call.path.startsWith('/draft/') ? 100 : undefined })
    const pending = webui('POST', '/test', {
      source: 'saved',
      draft: ai('renamed', { baseUrl: `${fake.url}/draft`, apiKey: 'typed-key', models: ['first', 'picked'], headers: { 'x-current': 'yes' }, body: { enable_thinking: false }, proxy: false }),
      model: 'picked',
    })
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    await app.ctx.ai.chat('live')
    expect(await pending).toMatchObject({ status: 200, success: true, data: { ok: true, model: 'picked', latency: expect.any(Number) } })
    expect(fake.calls[0]).toMatchObject({ path: '/draft/chat/completions', headers: { authorization: 'Bearer typed-key', 'x-current': 'yes' }, json: { model: 'picked', enable_thinking: false } })
    expect(fake.calls[1]).toMatchObject({ path: '/v1/chat/completions', headers: { authorization: 'Bearer key-saved' }, json: { model: 'saved-model' } })
    expect(connections).toEqual([{ proxyAgent: '' }, { proxyAgent: undefined }])
    expect(app.ctx.ai.list()).toEqual([{ name: 'saved', model: 'saved-model', models: ['saved-model'], proxy: true }])
    expect([...(app.ctx.get('ai') as AiProviderService).stats]).toEqual([['saved', { calls: 1, failures: 0, latency: expect.any(Number) }]])
  })

  it('restores a masked draft key by its original saved name, and honors a cleared key', async () => {
    await mount({ ais: [ai('a'), ai('b')] })
    expect(await webui('POST', '/test', { draft: ai('renamed', { apiKey: '********#12345678' }), source: 'b' })).toMatchObject({ data: { ok: true } })
    expect(fake.calls[0].headers.authorization).toBe('Bearer key-b')
    expect(await webui('POST', '/test', { draft: ai('renamed', { apiKey: '' }), source: 'b' })).toMatchObject({ data: { ok: true } })
    expect(fake.calls[1].headers.authorization).toBeUndefined()
    expect((app.ctx.get('ai') as AiProviderService).stats.size).toBe(0)
  })

  it('never forwards a key mask or reuses a saved key at a changed origin', async () => {
    await mount({ ais: [ai('a')] })
    const masked = ai('a', { apiKey: '********#12345678' })
    for (const body of [
      { draft: masked },
      { draft: masked, source: 'missing' },
      { draft: { ...masked, baseUrl: `${fake.url.replace('127.0.0.1', 'localhost')}/v1` }, source: 'a' },
    ]) {
      expect(await webui('POST', '/test', body)).toMatchObject({ data: { ok: false, kind: 'config' } })
      expect(await webui('POST', '/models', body)).toMatchObject({ status: 400, success: false, kind: 'config' })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('fetches models from the current draft, normalizing IDs without changing saved models', async () => {
    await mount({ ais: [ai('a')] })
    answer = () => ({ json: { data: [{ id: ' m1 ' }, { id: 'm1' }, { id: 'm2' }, { id: ' ' }] } })
    expect(await webui('POST', '/models', {
      source: 'a', draft: ai('renamed', { baseUrl: `${fake.url}/draft/chat/completions/`, apiKey: '********#12345678', models: [], headers: { 'x-draft': 'yes' } }),
    })).toEqual({ status: 200, success: true, data: { models: ['m1', 'm2'] } })
    expect(fake.calls[0]).toMatchObject({ method: 'GET', path: '/draft/models', headers: { authorization: 'Bearer key-a', 'x-draft': 'yes' } })
    expect(app.ctx.ai.get('a')?.models).toEqual(['a-model'])
    expect((app.ctx.get('ai') as AiProviderService).stats.size).toBe(0)
    answer = () => ({ json: { data: [] } })
    expect(await webui('POST', '/models', { draft: ai('new', { models: [], apiKey: 'new-key' }) })).toMatchObject({ data: { models: [] } })
    expect(fake.calls[1].headers.authorization).toBe('Bearer new-key')
  })

  it('reports draft validation, malformed model lists and provider failures without leaking input', async () => {
    await mount({ ais: [] })
    const draft = ai('new')
    for (const body of [null, {}, { draft, model: 3 }, { draft, source: [] }]) {
      expect(await webui('POST', '/models', body)).toMatchObject({ status: 400, success: false })
    }
    const invalid = await webui('POST', '/models', { draft: { ...draft, baseUrl: 'bad address', apiKey: 'keep-this-secret' } })
    expect(invalid).toMatchObject({ status: 400, success: false, kind: 'config' })
    expect(JSON.stringify(invalid)).not.toContain('keep-this-secret')
    expect(fake.calls).toHaveLength(0)
    for (const json of [{}, { data: 'wrong' }, { data: [null] }, { data: [{ id: 7 }] }]) {
      answer = () => ({ json })
      expect(await webui('POST', '/models', { draft })).toMatchObject({ status: 502, success: false, kind: 'response' })
    }
    answer = () => ({ body: Buffer.from('not JSON'), type: 'application/json' })
    expect(await webui('POST', '/models', { draft })).toMatchObject({ status: 502, kind: 'response' })
    answer = () => ({ status: 401, json: { error: { message: 'bad key' } } })
    expect(await webui('POST', '/models', { draft })).toMatchObject({ status: 502, kind: 'auth' })
    expect(await webui('POST', '/test', { draft })).toMatchObject({ data: { ok: false, kind: 'auth' } })
    answer = () => ({ json: { data: [] }, delay: 200 })
    expect(await webui('POST', '/models', { draft: { ...draft, timeout: 20 } })).toMatchObject({ status: 502, kind: 'timeout' })
    expect(await webui('POST', '/test', { draft: { ...draft, timeout: 20 } })).toMatchObject({ data: { ok: false, kind: 'timeout' } })
  })

  it('streams the reply piece by piece', async () => {
    answer = () => ({
      sse: [
        JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '你' } }] }),
        ': keep-alive',
        JSON.stringify({ choices: [{ delta: { content: '好呀' } }] }),
        '[DONE]',
      ],
    })
    await mount({ ais: [ai('s')] })
    const pieces: string[] = []
    for await (const piece of app.ctx.ai.stream('你好')) pieces.push(piece)
    expect(pieces).toEqual(['你', '好呀'])
    expect(fake.calls[0].json.stream).toBe(true)
  })

  it('tells the failures apart, and counts them', async () => {
    // A port nothing listens on any more (fetch refuses some low ports outright, as "bad port")
    const closed = await freePort()
    await mount({ ais: [ai('a'), ai('slow', { timeout: 100 }), ai('gone', { baseUrl: `http://127.0.0.1:${closed}/v1` })] })
    answer = () => ({ status: 401, json: { error: { message: 'Incorrect API key provided' } } })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({
      name: 'AiError', kind: 'auth', status: 401, ai: 'a', message: 'a answered 401: Incorrect API key provided',
    })
    answer = () => ({ status: 429, json: { error: { message: 'Rate limit reached' } } })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'rate-limit', status: 429 })
    answer = () => ({ status: 503, json: { message: 'overloaded' } })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'server', message: 'a answered 503: overloaded' })
    answer = () => ({ json: { choices: [] } })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'response' })
    expect(await failure(app.ctx.ai.chat('x', { ai: 'nobody' }))).toMatchObject({ kind: 'config', message: 'no AI service named nobody' })
    answer = () => ({ json: completion('迟到了'), delay: 1000 })
    expect(await failure(app.ctx.ai.chat('x', { ai: 'slow' }))).toMatchObject({ kind: 'timeout' })
    expect(await failure(app.ctx.ai.chat('x', { ai: 'gone' }))).toMatchObject({ kind: 'network', code: 'ECONNREFUSED', message: expect.stringContaining('ECONNREFUSED') })
    const provider = app.ctx.get('ai') as AiProviderService
    expect(provider.stats.get('a')).toMatchObject({ calls: 4, failures: 4, lastError: { message: 'a gave no message in its answer' } })
  })

  it('says when no AI is set up', async () => {
    await mount({ ais: [] })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'config', message: 'no AI service is set up' })
    expect(app.ctx.ai.get()).toBeUndefined()
  })

  it('reaches the rest of the API with the key in place', async () => {
    answer = call => (call.path === '/v1/models' ? { json: { data: [{ id: 'm1' }] } } : undefined)
    await mount({ ais: [ai('a', { apiKey: '' , headers: { 'api-key': 'azure-style' } }), ai('b')], default: 'b' })
    const response = await app.ctx.ai.request(undefined, 'models')
    expect(await response.json()).toEqual({ data: [{ id: 'm1' }] })
    expect(fake.calls[0].headers.authorization).toBe('Bearer key-b')
    // An empty key sends no Authorization: the provider takes it in a header of its own
    await app.ctx.ai.request('a', '/models')
    expect(fake.calls[1].headers.authorization).toBeUndefined()
    expect(fake.calls[1].headers['api-key']).toBe('azure-style')
    expect(await failure(app.ctx.ai.request('b', '/nothing'))).toMatchObject({ kind: 'request', status: 404 })
  })

  it('takes new settings without restarting the plugins that use it', async () => {
    const fiber = await mount({ ais: [ai('a')] })
    let applied = 0
    await app.ctx.plugin({
      name: 'user',
      inject: ['ai'],
      apply() {
        applied++
      },
    })
    expect(applied).toBe(1)
    await fiber.update({ ais: [ai('a'), ai('c')], default: 'c' })
    expect(app.ctx.ai.get()?.name).toBe('c')
    expect(applied).toBe(1)
  })

  it('uses the HTTP proxy hook and lets each AI opt out', async () => {
    const proxy = await startConnectProxy()
    let dispatcher: ProxyAgent | undefined
    let detach: (() => void) | undefined
    try {
      // Hosts only the proxy reaches: it tunnels to 127.0.0.1, while going direct fails on the name
      const port = new URL(fake.url).port
      await mount({ ais: [ai('far', { baseUrl: `http://far.invalid:${port}/v1` }), ai('near', { baseUrl: `http://near.invalid:${port}/v1`, proxy: false })] })
      // Without a proxy hook every AI goes direct
      expect(await failure(app.ctx.ai.chat('x', { ai: 'far' }))).toMatchObject({ kind: 'network', message: expect.stringContaining('ENOTFOUND') })
      const authorized = new URL(proxy.url)
      authorized.username = 'me'
      authorized.password = 'p@ss'
      dispatcher = new ProxyAgent(authorized.href)
      detach = app.ctx.on('http/fetch-init', (_url, init, config) => {
        if (config.proxyAgent !== '') init.dispatcher = dispatcher
      })
      expect(await app.ctx.ai.chat('x', { ai: 'far' })).toMatchObject({ text: '好的' })
      expect(proxy.tunnels).toEqual([{ target: `far.invalid:${port}`, authorization: `Basic ${Buffer.from('me:p@ss').toString('base64')}` }])
      expect(await failure(app.ctx.ai.chat('x', { ai: 'near' }))).toMatchObject({ kind: 'network' })
      expect(proxy.tunnels).toHaveLength(1)
      expect(fake.calls).toHaveLength(1)
    } finally {
      detach?.()
      await dispatcher?.close()
      await proxy.close()
    }
  })

  it('answers its WebUI module: the AIs with how they did, and a test call', async () => {
    await mount({ ais: [ai('a'), ai('b')] })
    const provider = app.ctx.get('ai') as AiProviderService
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await Provider.handle(provider, new Request(`http://bot${path}`, { method, body: body && JSON.stringify(body) }))
      return { status: response.status, ...await response.json() as { data?: any } }
    }
    expect(await call('POST', '/api/aiprovider/test', { ai: 'a' })).toMatchObject({
      status: 200, data: { ok: true, model: 'a-model', text: '好的' },
    })
    answer = () => ({ status: 401, json: { error: { message: 'bad key' } } })
    expect(await call('POST', '/api/aiprovider/test', { ai: 'b' })).toMatchObject({
      data: { ok: false, kind: 'auth', error: 'b answered 401: bad key' },
    })
    expect(await call('GET', '/api/aiprovider/ais')).toMatchObject({
      data: {
        default: 'a',
        ais: [
          { name: 'a', models: ['a-model'], model: 'a-model', calls: 1, failures: 0 },
          { name: 'b', calls: 1, failures: 1, lastError: { message: 'b answered 401: bad key' } },
        ],
      },
    })
    expect(await call('POST', '/api/aiprovider/test', {})).toMatchObject({ status: 400 })
  })

  it('keeps a stream going while pieces come, and gives up when they stop', async () => {
    await mount({ ais: [ai('s', { timeout: 500 })] })
    // Longer than the timeout in all, never that long between two pieces
    answer = () => ({ sse: [piece('一'), piece('二'), piece('三'), piece('四'), '[DONE]'], interval: 150 })
    expect(await collect(app.ctx.ai.stream('x'))).toEqual(['一', '二', '三', '四'])
    answer = () => ({ sse: [piece('一')], hold: true })
    const pieces: string[] = []
    const error = await failure((async () => {
      for await (const item of app.ctx.ai.stream('x')) pieces.push(item)
    })())
    expect(pieces).toEqual(['一'])
    expect(error).toMatchObject({ kind: 'timeout' })
    // chat() waits for the whole answer, so an answer that stops halfway is a timeout too
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'timeout' })
  })

  it('takes an answer at once when a stream was asked for', async () => {
    await mount({ ais: [ai('a')] })
    expect(await collect(app.ctx.ai.stream('x'))).toEqual(['好的'])
  })

  it('refuses an address without http://, in the settings and at a call', async () => {
    expect(() => Provider.Config({ ais: [{ name: 'a', baseUrl: 'api.example.com/v1', model: 'm' }] } as never)).toThrow()
    const entry = { name: 'typo', baseUrl: 'api.example.com/v1', apiKey: '', models: ['m'], proxy: true, timeout: 1000, headers: {}, body: {} }
    await app.ctx.plugin(AiProviderService, { current: { ais: [entry], default: '' } })
    await vi.waitFor(() => expect(app.ctx.get('ai')).toBeTruthy())
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ name: 'AiError', kind: 'config', ai: 'typo' })
    expect((app.ctx.get('ai') as AiProviderService).stats.get('typo')).toMatchObject({ calls: 1, failures: 1 })
  })

  it('does not count the caller\'s own abort as a failure', async () => {
    answer = () => ({ json: completion('迟到了'), delay: 1000 })
    await mount({ ais: [ai('a')] })
    const controller = new AbortController()
    const reason = new Error('user left')
    setTimeout(() => controller.abort(reason), 50)
    expect(await failure(app.ctx.ai.chat('x', { signal: controller.signal }))).toBe(reason)
    expect((app.ctx.get('ai') as AiProviderService).stats.get('a')).toEqual({ calls: 1, failures: 0 })
  })

  it('asks again without what a reasoning model refuses', async () => {
    answer = (call) => {
      const refused = 'temperature' in call.json ? 'temperature' : 'max_tokens' in call.json ? 'max_tokens' : undefined
      if (!refused) return { json: completion('好的') }
      return { status: 400, json: { error: { message: `Unsupported parameter: '${refused}'`, type: 'invalid_request_error', param: refused, code: 'unsupported_parameter' } } }
    }
    await mount({ ais: [ai('o')] })
    expect(await app.ctx.ai.chat('x', { temperature: 0, maxTokens: 5 })).toMatchObject({ text: '好的' })
    const sent = (call: FakeCall) => Object.keys(call.json).filter(key => key !== 'model' && key !== 'messages')
    expect(fake.calls.map(sent)).toEqual([['temperature', 'max_tokens'], ['max_tokens'], ['max_completion_tokens']])
    expect(fake.calls[2].json.max_completion_tokens).toBe(5)
    expect((app.ctx.get('ai') as AiProviderService).stats.get('o')).toEqual({ calls: 1, failures: 0, latency: expect.any(Number) })
    // Any other 400 is the caller's to fix
    answer = () => ({ status: 400, json: { error: { message: 'bad messages', param: 'messages', code: 'invalid_value' } } })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'request', status: 400, code: 'invalid_value' })
    expect(fake.calls).toHaveLength(4)
  })

  it('tries once more after a 5xx or a dropped connection', async () => {
    await mount({ ais: [ai('a')] })
    let trouble: FakeAnswer[] = [{ status: 503, json: { error: { message: 'overloaded' } } }]
    answer = () => trouble.shift() ?? { json: completion('好的') }
    expect(await app.ctx.ai.chat('x')).toMatchObject({ text: '好的' })
    trouble = [{ drop: true }]
    expect(await app.ctx.ai.chat('x')).toMatchObject({ text: '好的' })
    expect(fake.calls).toHaveLength(4)
    expect((app.ctx.get('ai') as AiProviderService).stats.get('a')).toMatchObject({ calls: 2, failures: 0 })
    trouble = [{ status: 503, json: { error: { message: 'overloaded' } } }, { status: 503, json: { error: { message: 'still overloaded' } } }]
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'server', status: 503, message: 'a answered 503: still overloaded' })
    expect(fake.calls).toHaveLength(6)
  })

  it('leaves the thinking out of the answer', async () => {
    await mount({ ais: [ai('r')] })
    answer = () => ({ json: completion('<think>\n先想想\n</think>\n\n好的') })
    expect(await app.ctx.ai.chat('x')).toMatchObject({ text: '好的', reasoning: '先想想' })
    answer = () => ({ json: { model: 'r1', choices: [{ message: { role: 'assistant', content: '好的', reasoning_content: '想过了' }, finish_reason: 'stop' }] } })
    expect(await app.ctx.ai.chat('x')).toMatchObject({ text: '好的', reasoning: '想过了' })
    // The tags may come split over the pieces
    answer = () => ({ sse: [piece('<thi'), piece('nk>想'), piece('想</th'), piece('ink>\n'), piece('好'), piece('的'), '[DONE]'] })
    expect(await collect(app.ctx.ai.stream('x'))).toEqual(['好', '的'])
    // What only looked like the start of one is the answer
    answer = () => ({ sse: [piece('<th'), '[DONE]'] })
    expect(await collect(app.ctx.ai.stream('x'))).toEqual(['<th'])
    answer = () => ({ sse: [piece('<b>粗</b>'), '[DONE]'] })
    expect(await collect(app.ctx.ai.stream('x'))).toEqual(['<b>粗</b>'])
  })

  it('tells an empty balance from a rate limit', async () => {
    await mount({ ais: [ai('a')] })
    answer = () => ({ status: 402, json: { error: { message: 'Insufficient Balance' } } })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'quota', status: 402 })
    answer = () => ({ status: 429, json: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } } })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'quota', code: 'insufficient_quota' })
    answer = () => ({ status: 429, json: { error: { message: '您的账户已欠费，请充值后重试', code: '1113' } } })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'quota', code: '1113' })
    answer = () => ({ status: 429, json: { error: { message: 'Quota exceeded for metric: requests per minute', code: 'rate_limit_exceeded' } } })
    expect(await failure(app.ctx.ai.chat('x'))).toMatchObject({ kind: 'rate-limit', code: 'rate_limit_exceeded' })
  })
})
