import { Context, Schema } from '@luckylillia/plugin-sdk'
import { AiEntry, AiError, AiProviderService, ProviderSettings, ProviderState } from './provider.js'

export type * from './types.js'

export const name = 'aiprovider'

export interface AiConfig {
  name: string
  baseUrl: string
  apiKey: string
  models?: string[]
  /** @deprecated Read old settings until the model list is first saved. */
  model?: string
  proxy: boolean
  timeout: number
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface Config {
  ais: AiConfig[]
  default: string
}

const AiSchema: Schema<AiConfig> = Schema.object({
  name: Schema.string().required().description('服务名称：别的插件按它选择，起好后别再改'),
  baseUrl: Schema.string().role('link').pattern(/^https?:\/\/\S+$/i).required().description(
    'OpenAI 兼容的接口地址，填到版本号为止，例如 DeepSeek：https://api.deepseek.com/v1（带 /chat/completions 的完整地址也行）',
  ),
  apiKey: Schema.string().role('secret').default('').description('API Key'),
  // Schemastery arrays normally default to []; keep absence distinct so old `model` values survive upgrades.
  models: Schema.array(Schema.string()).extra('default', undefined).description('模型列表：自动获取或手动添加，由调用插件选择'),
  model: Schema.string().hidden(),
  proxy: Schema.boolean().default(true).description('走代理：内置的「代理」插件填了地址时经它连接。国内能直连的服务（DeepSeek 等）可以关掉'),
  timeout: Schema.natural().role('ms').default(120_000).description('等多久没有回答就算失败；流式回答是两段之间最多等多久'),
  headers: Schema.dict(Schema.string()).default({}).description('额外的请求头'),
  body: Schema.dict(Schema.any()).default({}).description('请求体里额外带的字段，比如关掉思考：enable_thinking 填 false'),
})

export const Config: Schema<Config> = Schema.object({
  ais: Schema.array(AiSchema).default([]).description('服务列表'),
  default: Schema.string().role('ai').default('').description('默认服务：别的插件没指定时用它，留空就用列表里第一个'),
})

/** `https://api.openai.com/v1/chat/completions/` and `https://api.openai.com/v1` alike become the latter */
export function baseUrlOf(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
}

function settingsOf(ctx: Context, config: Config): ProviderSettings {
  const ais: AiEntry[] = []
  for (const ai of config.ais) {
    const name = ai.name.trim()
    if (ais.some(entry => entry.name === name)) {
      ctx.logger('aiprovider').warn(`two AI services are named ${name}, the second is left out`)
      continue
    }
    ais.push(entryOf(ai))
  }
  return { ais, default: config.default.trim() }
}

function entryOf(ai: AiConfig): AiEntry {
  return {
    name: ai.name.trim(),
    baseUrl: baseUrlOf(ai.baseUrl),
    apiKey: ai.apiKey.trim(),
    models: [...new Set((ai.models ?? (ai.model ? [ai.model] : [])).map(model => model.trim()).filter(Boolean))],
    proxy: ai.proxy,
    timeout: ai.timeout,
    headers: { ...ai.headers },
    body: { ...ai.body },
  }
}

export function apply(ctx: Context, config: Config) {
  const settings: ProviderState = { current: settingsOf(ctx, config) }
  // A change of settings applies in place: restarting the service would restart every plugin using it
  ctx.on('internal/update', (next: Config) => {
    settings.current = settingsOf(ctx, next)
  })
  ctx.plugin(AiProviderService, settings)
  ctx.inject(['webuiServer', 'ai'], (ctx) => {
    const provider = ctx.ai as AiProviderService
    ctx.webuiServer.route('/api/aiprovider', { fetch: request => handle(provider, request) })
  })
}

function draftOf(value: unknown): AiEntry {
  try {
    const draft = entryOf(AiSchema(value as AiConfig))
    if (!draft.name || !['http:', 'https:'].includes(new URL(draft.baseUrl).protocol)) throw new Error('invalid draft')
    return draft
  } catch {
    // Schema errors can contain supplied values, including keys; do not return those to the browser.
    throw new AiError('当前接口设置不完整或格式不正确，请检查名称、地址、超时和请求头', 'config')
  }
}

/** Lists saved endpoints; test and model-discovery calls use only the current form draft. */
export async function handle(provider: AiProviderService, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/api/aiprovider/ais' && request.method === 'GET') {
    const ais = provider.list().map(ai => ({ ...ai, ...provider.stats.get(ai.name) }))
    return Response.json({ success: true, data: { default: provider.defaultName() ?? '', ais } })
  }
  if ((path === '/api/aiprovider/test' || path === '/api/aiprovider/models') && request.method === 'POST') {
    const payload = await request.json().catch(() => undefined)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return Response.json({ success: false, message: 'draft is required' }, { status: 400 })
    }
    const { ai, draft, source, model } = payload as { ai?: unknown; draft?: unknown; source?: unknown; model?: unknown }
    const discovery = path.endsWith('/models')
    if ((!draft && (discovery || typeof ai !== 'string' || !ai))
      || (source !== undefined && typeof source !== 'string')
      || (model !== undefined && typeof model !== 'string')) {
      return Response.json({ success: false, message: 'draft, source or model is invalid' }, { status: 400 })
    }
    const started = Date.now()
    try {
      if (discovery) {
        return Response.json({ success: true, data: { models: await provider.models(draftOf(draft), source as string | undefined) } })
      }
      const result = draft
        ? await provider.test(draftOf(draft), source as string | undefined, model as string | undefined)
        : await provider.chat('只回复两个字母：OK', { ai: ai as string, model: model as string | undefined })
      return Response.json({ success: true, data: { ok: true, latency: Date.now() - started, model: result.model, text: result.text.slice(0, 200) } })
    } catch (e) {
      const error = e as AiError
      if (discovery) return Response.json({ success: false, message: error.message, kind: error.kind }, { status: error.kind === 'config' ? 400 : 502 })
      return Response.json({ success: true, data: { ok: false, latency: Date.now() - started, kind: error.kind, error: error.message } })
    }
  }
  return Response.json({ success: false, message: 'not found' }, { status: 404 })
}
