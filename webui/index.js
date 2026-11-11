// Plain ES module, no build step: React and the SDK come from the WebUI's import map.
import { createElement as h, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, SchemaForm, SelectInput, usePluginConfig, usePluginContext } from '@luckylillia/plugin-sdk/webui'

const errorStyle = { color: 'rgb(239 68 68)', fontSize: 12, overflowWrap: 'anywhere' }
const mutedStyle = { fontSize: 12, lineHeight: 1.6 }
const stack = { display: 'grid', gap: 8, minWidth: 0 }
const line = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const messageOf = error => error instanceof Error ? error.message : String(error)
const isSecretMask = value => typeof value === 'string' && (value === '********' || value.startsWith('********#'))
const uniqueModels = models => [...new Set(models.filter(model => typeof model === 'string').map(model => model.trim()).filter(Boolean))]
const modelsOf = ai => uniqueModels(Array.isArray(ai?.models) ? ai.models : ai?.model ? [ai.model] : [])

function editableAi(ai) {
  const { model, vision, ...current } = ai
  return { apiKey: '', proxy: true, timeout: 120000, headers: {}, body: {}, ...current, models: modelsOf(ai) }
}

// Dropdowns share a short-lived request; saving the provider invalidates it.
let cached = { at: 0, promise: undefined }
function fetchAis(ctx, fresh = false) {
  if (fresh || !cached.promise || Date.now() - cached.at > 5000) {
    const request = ctx.api('/api/aiprovider/ais')
    cached = { at: Date.now(), promise: request }
    request.catch(() => {
      if (cached.promise === request) cached = { at: 0, promise: undefined }
    })
  }
  return cached.promise
}

function useAis() {
  const ctx = usePluginContext()
  const [state, setState] = useState(null)
  const sequence = useRef(0)
  const load = useCallback((fresh) => {
    const request = ++sequence.current
    fetchAis(ctx, fresh).then(
      data => request === sequence.current && setState(data),
      error => request === sequence.current && setState({ failed: messageOf(error) }),
    )
  }, [ctx])
  useEffect(() => {
    load(false)
    return () => { sequence.current++ }
  }, [load])
  return [state, () => load(true)]
}

function providerOptions(state, value) {
  const ais = state?.ais ?? []
  const options = [{ value: '', label: '跟随默认服务' }]
  for (const ai of ais) options.push({ value: ai.name, label: ai.name })
  if (value && !ais.some(ai => ai.name === value)) {
    options.push({ value, label: `${value}（${state && !state.failed ? '服务已不存在' : '尚未载入'}）` })
  }
  return options
}

function ProviderListNotice({ state, reload }) {
  const text = !state ? '正在加载服务…'
    : state.failed ? `无法读取服务列表：${state.failed}` : ''
  return text && h('div', { style: line },
    h('span', { className: 'text-theme-muted', style: mutedStyle }, text),
    state?.failed && h('button', { type: 'button', className: 'btn-glass text-xs', onClick: reload }, '重试'),
  )
}

function EmptyServiceField({ provider, hint, error }) {
  const ctx = usePluginContext()
  return h('div', { style: stack },
    h('span', { className: 'text-theme-muted', style: mutedStyle },
      provider === 'openai' ? '无可用的 OpenAI 官方服务，请先' : '无可用服务，请先',
      h('a', { href: ctx.pageHref('settings'), className: 'text-pink-500 underline underline-offset-2' }, '设置'),
    ),
    typeof hint === 'string' && hint && h('span', { className: 'text-theme-muted', style: mutedStyle }, hint),
    error && h('span', { style: errorStyle }, error),
  )
}

/** For calls to a provider's other APIs, where no chat model is involved. */
function AiField({ value, onChange, error, meta }) {
  const [state, reload] = useAis()
  const provider = meta?.extra?.provider
  const ais = (state?.ais ?? []).filter(ai => !provider || ai.provider === provider)
  const ready = !!state && !state.failed
  if (ready && !ais.length) return h(EmptyServiceField, { provider, hint: meta?.extra?.emptyHint, error })
  if (provider) {
    const invalid = ready && !!value && !ais.some(ai => ai.name === value)
    const providerLabel = provider === 'openai' ? 'OpenAI 官方服务' : `${provider} 服务`
    const options = ais.map(ai => ({ value: ai.name, label: ai.name }))
    const selected = value || ais.find(ai => ai.name === state?.default)?.name || ais[0]?.name || ''
    const placeholder = !state ? '正在加载服务…' : state.failed ? '服务列表未加载' : `请选择 ${providerLabel}`
    return h('div', { style: stack },
      h(SelectInput, { value: selected, options, onChange, placeholder, disabled: !state }),
      !ready && h(ProviderListNotice, { state, reload }),
      invalid && h('span', { style: errorStyle }, `已保存的服务不存在或不是 ${providerLabel}，请重新选择。`),
      error && h('span', { style: errorStyle }, error),
    )
  }
  return h('div', { style: stack },
    h(SelectInput, { value: value ?? '', options: providerOptions(state, value), onChange, disabled: !state }),
    h(ProviderListNotice, { state, reload }),
    error && h('span', { style: errorStyle }, error),
  )
}

/** Each consumer chooses a provider first, then one of that provider's models. */
function AiModelField({ value, onChange, error }) {
  const [state, reload] = useAis()
  if (state && !state.failed && !state.ais?.length) return h(EmptyServiceField, { error })
  const selection = typeof value === 'string' ? { ai: value, model: '' } : value ?? { ai: '', model: '' }
  const name = selection.ai || state?.default || state?.ais?.[0]?.name
  const provider = state?.ais?.find(ai => ai.name === name)
  const models = modelsOf(provider)
  const model = selection.model ?? ''
  const options = [{ value: '', label: models.length ? '使用服务的首个模型' : '请选择模型' },
    ...models.map(value => ({ value, label: value }))]
  const missing = !!state && !state.failed && !!model && !models.includes(model)
  if (model && !models.includes(model)) options.push({ value: model, label: `${model}（${missing ? '未在该服务列出' : '尚未载入'}）` })

  return h('div', { style: stack },
    h('label', { style: stack },
      h('span', { className: 'text-theme-secondary', style: mutedStyle }, '服务'),
      h(SelectInput, { value: selection.ai ?? '', options: providerOptions(state, selection.ai), disabled: !state,
        onChange: ai => onChange({ ai, model: '' }) }),
    ),
    h('label', { style: stack },
      h('span', { className: 'text-theme-secondary', style: mutedStyle }, '模型'),
      h(SelectInput, { value: model, options, disabled: !provider,
        onChange: model => onChange({ ai: selection.ai ?? '', model }) }),
    ),
    h(ProviderListNotice, { state, reload }),
    provider && !models.length && h('span', { className: 'text-theme-muted', style: mutedStyle }, '这个服务还没有模型，请在 AI 服务中获取或手动添加。'),
    missing && h('span', { style: errorStyle }, '已配置的模型不在这个服务的模型列表中，请重新选择或到服务中添加。'),
    error && h('span', { style: errorStyle }, error),
  )
}

const KIND_TEXT = {
  config: '设置有误', auth: 'Key 不对或没有权限', quota: '余额或额度用完了',
  'rate-limit': '请求太频繁了', request: '请求被拒绝，请检查模型名称', server: '对方服务出错',
  network: '无法连接，请检查地址和代理', timeout: '超时', response: '无法读取回答，请检查接口是否兼容 OpenAI',
}

function TestResult({ result, signature }) {
  if (!result) return null
  if (result.signature !== signature) return h('span', { className: 'text-theme-muted', style: mutedStyle }, '设置已修改，请重新测试。')
  if (result.pending) return h('span', { className: 'text-theme-muted', style: mutedStyle }, '测试中…')
  if (result.ok) return h('span', { className: 'text-green-600 dark:text-green-400', style: { fontSize: 13, overflowWrap: 'anywhere' } },
    `连接成功，${result.latency} 毫秒。回答：${result.text}`)
  const kind = KIND_TEXT[result.kind]
  return h('span', { style: errorStyle }, `测试失败${kind ? `（${kind}）` : ''}：${result.error}`)
}

function TextField({ label, value, onChange, error, hint, ...props }) {
  const id = useId()
  return h('div', { style: stack },
    h('label', { htmlFor: id, className: 'text-sm font-medium text-theme-secondary' }, label),
    h('input', { id, className: 'input-field', value: value ?? '', onChange: event => onChange(event.target.value),
      'aria-invalid': !!error, ...props }),
    hint && h('span', { className: 'text-theme-muted', style: mutedStyle }, hint),
    error && h('span', { style: errorStyle }, error),
  )
}

// List secrets use the SDK's token mask. Only the explicit Clear action sends an empty stored key.
function ApiKeyField({ value = '', onChange, error }) {
  const id = useId()
  const [reveal, setReveal] = useState(false)
  const lastMask = useRef()
  const cleared = useRef(false)
  const stored = isSecretMask(value)
  if (stored) { lastMask.current = value; cleared.current = false }
  return h('div', { style: stack },
    h('label', { htmlFor: id, className: 'text-sm font-medium text-theme-secondary' }, 'API Key'),
    h('div', { style: { display: 'flex', gap: 8 } },
      h('input', { id, className: 'input-field', style: { flex: 1, minWidth: 0 }, value,
        type: reveal && !stored ? 'text' : 'password', autoComplete: 'new-password', 'aria-invalid': !!error,
        placeholder: cleared.current ? '保存后清空已存的 Key' : '可留空',
        onFocus: event => stored && event.target.select(),
        onChange: event => onChange(event.target.value),
        onBlur: () => { if (!value && !cleared.current && lastMask.current) onChange(lastMask.current) },
      }),
      !stored && value && h('button', { type: 'button', className: 'btn-glass text-sm', style: { flexShrink: 0 },
        'aria-label': reveal ? '隐藏 API Key' : '显示 API Key', onClick: () => setReveal(!reveal) }, reveal ? '隐藏' : '显示'),
      (value || lastMask.current) && h('button', { type: 'button', className: 'btn-glass text-sm', style: { flexShrink: 0 },
        'aria-label': '清空 API Key', onClick: () => { cleared.current = true; lastMask.current = undefined; onChange('') } }, '清空'),
    ),
    stored && h('span', { className: 'text-theme-muted', style: mutedStyle }, '已保存；输入新 Key 可替换。'),
    error && h('span', { style: errorStyle }, error),
  )
}

// Keep the original refs so SDK SchemaForm can render the endpoint's advanced fields.
function endpointSchema(schema) {
  if (!schema?.refs) return null
  const resolve = ref => typeof ref === 'number' ? schema.refs[ref] : ref
  const root = resolve(schema.uid)
  const list = resolve(root?.dict?.ais)
  const item = resolve(list?.inner)
  return item ? { uid: -1, refs: { ...schema.refs, [-1]: { ...item, meta: {} } } } : null
}

function connectionSignature(ai, source) {
  const { models, ...connection } = editableAi(ai)
  return JSON.stringify([connection, source])
}

function AiEditor({ ai, source, schema, errors, onUpdate, onRemove, embedded = false }) {
  const ctx = usePluginContext()
  const [modelName, setModelName] = useState('')
  const [modelError, setModelError] = useState('')
  const [discovery, setDiscovery] = useState(null)
  const [results, setResults] = useState({})
  const latest = useRef(ai)
  latest.current = ai
  const removedDuringFetch = useRef(new Set())
  const models = modelsOf(ai)
  const signature = connectionSignature(ai, source)
  const patch = updates => onUpdate(previous => ({ ...previous, ...updates }))
  const body = () => {
    const draft = editableAi(latest.current)
    if (isSecretMask(draft.apiKey) && !source) throw new Error('无法找到已保存的 Key，请重新输入。')
    return { draft, ...(source ? { source } : {}) }
  }
  const addModel = () => {
    const name = modelName.trim()
    if (!name) return
    if (modelsOf(latest.current).includes(name)) { setModelError('这个模型已经在列表中。'); return }
    removedDuringFetch.current.delete(name)
    onUpdate(previous => ({ ...previous, models: [...modelsOf(previous), name] }))
    setModelName('')
    setModelError('')
  }
  const removeModel = model => {
    removedDuringFetch.current.add(model)
    onUpdate(previous => ({ ...previous, models: modelsOf(previous).filter(other => other !== model) }))
  }
  const discover = async () => {
    const startedWith = connectionSignature(latest.current, source)
    const removed = new Set()
    removedDuringFetch.current = removed
    setDiscovery({ pending: true })
    try {
      const data = await ctx.api('/api/aiprovider/models', { body: body() })
      if (connectionSignature(latest.current, source) !== startedWith) {
        setDiscovery({ message: '服务设置已修改，请重新获取模型。' })
        return
      }
      const fetched = uniqueModels(data.models ?? []).filter(model => !removed.has(model))
      onUpdate(previous => ({ ...previous, models: uniqueModels([...modelsOf(previous), ...fetched]) }))
      setDiscovery({ message: data.models?.length ? `已获取 ${data.models.length} 个模型，已合并到列表。` : '接口没有返回模型，可以手动添加。' })
    } catch (error) {
      setDiscovery({ error: `${messageOf(error)}；也可以手动添加模型。` })
    }
  }
  const test = async model => {
    const startedWith = connectionSignature(latest.current, source)
    setResults(previous => ({ ...previous, [model]: { pending: true, signature: startedWith } }))
    let result
    try { result = await ctx.api('/api/aiprovider/test', { body: { ...body(), model } }) }
    catch (error) { result = { ok: false, error: messageOf(error) } }
    setResults(previous => ({ ...previous, [model]: { ...result, signature: startedWith } }))
  }
  const modelErrors = Object.entries(errors).filter(([path]) => path === 'models' || path.startsWith('models.')).map(([, error]) => error)

  return h('section', { className: embedded ? undefined : 'rounded-xl border border-theme-divider', style: { padding: embedded ? 0 : 20, display: 'grid', gap: 20 },
    'aria-label': `服务 ${ai.name || '未命名'}` },
    !embedded && h('div', { style: { ...line, justifyContent: 'space-between' } },
      h('h4', { className: 'text-theme font-semibold', style: { margin: 0, overflowWrap: 'anywhere' } }, ai.name || '新服务'),
      h('button', { type: 'button', className: 'btn-glass text-sm text-red-500', onClick: onRemove,
        'aria-label': `删除服务 ${ai.name || '未命名'}` }, '删除服务'),
    ),
    errors[''] && h('span', { style: errorStyle }, errors['']),
    h(TextField, { label: '服务名称', value: ai.name, onChange: name => patch({ name }), error: errors.name,
      placeholder: '例如：DeepSeek', hint: '其他插件按这个名称选择服务；改名后需要重新选择。' }),
    h(TextField, { label: '接口地址', value: ai.baseUrl, onChange: baseUrl => patch({ baseUrl }), error: errors.baseUrl,
      type: 'url', placeholder: 'https://api.deepseek.com/v1',
      hint: '填写 OpenAI 兼容接口的基础地址，例如 https://api.deepseek.com/v1。' }),
    h(ApiKeyField, { value: ai.apiKey, onChange: apiKey => patch({ apiKey }), error: errors.apiKey }),
    h('div', { style: { ...stack, gap: 12 } },
      h('div', { style: { ...line, justifyContent: 'space-between' } },
        h('span', { className: 'text-sm font-medium text-theme-secondary' }, `模型列表（${models.length}）`),
        h('button', { type: 'button', className: 'btn-glass text-sm', disabled: discovery?.pending || !ai.baseUrl?.trim(), onClick: discover },
          discovery?.pending ? '获取中…' : '自动获取模型'),
      ),
      h('span', { className: 'text-theme-muted', style: mutedStyle }, '获取和测试都使用当前填写的设置，无需先保存。其他插件各自选择这里的模型。'),
      h('div', { role: 'status', 'aria-live': 'polite' },
        discovery?.error ? h('span', { style: errorStyle }, discovery.error)
          : discovery?.message && h('span', { className: 'text-theme-secondary', style: mutedStyle }, discovery.message),
      ),
      models.length ? h('div', { className: 'rounded-lg border border-theme-divider', style: { maxHeight: 360, overflowY: 'auto' } },
        models.map(model => h('div', { key: model, className: 'border-theme-divider', style: { padding: '10px 12px', borderBottomWidth: 1 } },
          h('div', { style: { ...line, flexWrap: 'nowrap' } },
            h('code', { className: 'text-sm text-theme', style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, model),
            h('button', { type: 'button', className: 'btn-glass text-xs', disabled: results[model]?.pending,
              style: { flexShrink: 0 }, 'aria-label': `测试模型 ${model}`, onClick: () => test(model) }, results[model]?.pending ? '测试中…' : '测试'),
            h('button', { type: 'button', className: 'btn-glass text-xs', style: { flexShrink: 0 },
              'aria-label': `删除模型 ${model}`, onClick: () => removeModel(model) }, '删除'),
          ),
          results[model] && h('div', { role: 'status', 'aria-live': 'polite', style: { marginTop: 8 } }, h(TestResult, { result: results[model], signature })),
        )),
      ) : h('div', { className: 'text-theme-muted rounded-lg bg-theme-item', style: { padding: 16, fontSize: 13 } }, '还没有模型，点击自动获取，或在下方手动添加。'),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('input', { className: 'input-field text-sm', style: { flex: 1, minWidth: 0 }, value: modelName,
          'aria-label': `为 ${ai.name || '新服务'} 添加模型`, placeholder: '模型名称，例如 deepseek-chat',
          onChange: event => { setModelName(event.target.value); setModelError('') },
          onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); addModel() } } }),
        h('button', { type: 'button', className: 'btn-glass text-sm', style: { flexShrink: 0 }, disabled: !modelName.trim(), onClick: addModel }, '添加模型'),
      ),
      (modelError || modelErrors.length > 0) && h('span', { style: errorStyle }, modelError || modelErrors.join('；')),
    ),
    schema && h('details', { className: 'rounded-lg border border-theme-divider' },
      h('summary', { className: 'text-sm font-medium text-theme-secondary', style: { padding: '12px 14px', cursor: 'pointer' } }, '更多设置'),
      h('div', { style: { padding: '0 14px 14px' } }, h(SchemaForm, { schema, value: editableAi(ai),
        fields: ['proxy', 'timeout', 'headers', 'body'], errors, onChange: next => onUpdate(() => next) })),
    ),
  )
}

let nextRowId = 0

function ProviderEditor({ value, onChange, schema, errors = {}, actions }) {
  // Names and indexes can change. Retain an identity and the saved name for each draft row.
  const editor = useRef(null)
  if (!editor.current || editor.current.value !== value) {
    editor.current = { value, rows: (value?.ais ?? []).map(ai => ({ id: ++nextRowId, source: ai.name?.trim() })) }
  }
  const write = next => { editor.current.value = next; onChange(next) }
  const updateAi = (id, update) => {
    const current = editor.current
    const index = current.rows.findIndex(row => row.id === id)
    if (index < 0) return
    const previous = current.value.ais[index]
    const next = editableAi(update(previous))
    const ais = [...current.value.ais]
    ais[index] = next
    write({ ...current.value, ais, default: current.value.default && current.value.default === previous.name ? next.name : current.value.default })
  }
  const addProvider = () => {
    editor.current.rows.push({ id: ++nextRowId, source: undefined })
    write({ ...editor.current.value, ais: [...(editor.current.value?.ais ?? []),
      { name: '', baseUrl: '', apiKey: '', models: [], proxy: true, timeout: 120000, headers: {}, body: {} }] })
  }
  const removeProvider = id => {
    const current = editor.current
    const index = current.rows.findIndex(row => row.id === id)
    if (index < 0) return
    const removed = current.value.ais[index]
    current.rows.splice(index, 1)
    write({ ...current.value, ais: current.value.ais.filter((_, i) => i !== index),
      default: current.value.default === removed.name ? '' : current.value.default })
  }
  const ais = value?.ais ?? []
  const options = [{ value: '', label: '列表中的第一个服务' }, ...ais.filter(ai => ai.name?.trim()).map(ai => ({ value: ai.name, label: ai.name }))]
  if (value?.default && !options.some(option => option.value === value.default)) options.push({ value: value.default, label: `${value.default}（服务已不存在）` })
  const itemSchema = endpointSchema(schema)

  return h('div', { style: { display: 'grid', gap: 20 } },
    errors[''] && h('span', { style: errorStyle }, errors['']),
    !ais.length && h('div', { className: 'rounded-xl bg-theme-item text-theme-muted', style: { padding: 24, textAlign: 'center' } }, '还没有服务。添加接口地址和 Key，再获取或添加模型。'),
    ais.map((ai, index) => {
      const row = editor.current.rows[index]
      const prefix = `ais.${index}`
      const rowErrors = Object.fromEntries(Object.entries(errors).filter(([path]) => path === prefix || path.startsWith(`${prefix}.`))
        .map(([path, error]) => [path === prefix ? '' : path.slice(prefix.length + 1), error]))
      return h(AiEditor, { key: row.id, ai, source: row.source, schema: itemSchema, errors: rowErrors,
        onUpdate: update => updateAi(row.id, update), onRemove: () => removeProvider(row.id) })
    }),
    errors.ais && h('span', { style: errorStyle }, errors.ais),
    ais.length > 0 && h('label', { style: stack },
      h('span', { className: 'text-sm font-medium text-theme-secondary' }, '默认服务'),
      h(SelectInput, { value: value?.default ?? '', options, onChange: name => write({ ...editor.current.value, default: name }) }),
      h('span', { className: 'text-theme-muted', style: mutedStyle }, '供没有指定服务的插件使用。各插件仍可分别选择服务和模型。'),
      errors.default && h('span', { style: errorStyle }, errors.default),
    ),
    h('div', { style: { ...line, justifyContent: 'space-between' } },
      h('button', { type: 'button', className: 'btn-glass', onClick: addProvider }, '添加服务'),
      actions && h('div', { style: { marginLeft: 'auto', minWidth: 0 } }, actions),
    ),
  )
}

function ServiceDialog({ dialog, schema, errors, stale, disabled, onConfirm, onClose, returnFocus }) {
  const [draft, setDraft] = useState(() => editableAi(dialog.original ?? { name: '', baseUrl: '' }))
  const [localErrors, setLocalErrors] = useState({})
  const [submitError, setSubmitError] = useState('')
  const panel = useRef(null)
  const titleId = useId()
  const live = useRef()
  live.current = { disabled, stale, onClose }
  const removing = dialog.kind === 'remove'
  const title = removing ? '删除服务' : dialog.kind === 'add' ? '添加服务' : '编辑服务'

  useEffect(() => {
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const initial = panel.current?.querySelector('[data-initial-focus], input:not(:disabled)')
    ;(initial ?? panel.current)?.focus()
    const keydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!live.current.disabled) live.current.onClose()
      } else if (event.key === 'Tab') {
        const elements = [...(panel.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex]') ?? [])]
          .filter(element => element.tabIndex >= 0 && element.getClientRects().length)
        const first = elements[0]
        const last = elements[elements.length - 1]
        if (!first) { event.preventDefault(); panel.current?.focus() }
        else if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) {
          event.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      document.body.style.overflow = previousOverflow
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
      else returnFocus.current?.focus()
    }
  }, [])

  const close = () => { if (!live.current.disabled) onClose() }
  const confirm = event => {
    event.preventDefault()
    if (live.current.disabled || live.current.stale) return
    let entry
    if (!removing) {
      const name = draft.name?.trim() ?? ''
      if (!name) { setLocalErrors({ name: '请填写服务名称。' }); return }
      if ((dialog.snapshot.ais ?? []).some((ai, index) => index !== dialog.index && ai.name?.trim() === name)) {
        setLocalErrors({ name: '已经有同名服务，请换一个名称。' })
        return
      }
      const baseUrl = draft.baseUrl?.trim() ?? ''
      try {
        if (!['http:', 'https:'].includes(new URL(baseUrl).protocol)) throw new Error()
      } catch {
        setLocalErrors({ baseUrl: '请填写以 http:// 或 https:// 开头的接口地址。' })
        return
      }
      entry = editableAi({ ...draft, name, baseUrl })
    }
    if (!onConfirm(entry)) setSubmitError('配置已更新，请关闭弹框后重新打开。')
  }

  return createPortal(h('div', {
    style: { position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: 'rgba(0, 0, 0, 0.35)', backdropFilter: 'blur(4px)' },
    onMouseDown: event => { if (event.target === event.currentTarget) close() },
  }, h('form', { ref: panel, role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, tabIndex: -1,
    className: 'card glass-thick', noValidate: true, onSubmit: confirm,
    style: { width: removing ? 440 : 680, maxWidth: '100%', maxHeight: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', outline: 'none' },
  },
  h('div', { className: 'border-theme-divider', style: { ...line, justifyContent: 'space-between', padding: '18px 20px', borderBottomWidth: 1, flexShrink: 0 } },
    h('h3', { id: titleId, className: 'text-lg font-semibold text-theme', style: { margin: 0 } }, title),
    h('button', { type: 'button', className: 'btn-glass', 'aria-label': '关闭弹框', disabled, onClick: close,
      style: { padding: 8, display: 'flex' } }, h('span', { 'aria-hidden': true, style: { width: 18, fontSize: 24, lineHeight: '18px' } }, '×')),
  ),
  h('div', { style: { padding: 20, overflowY: 'auto', minHeight: 0, overscrollBehavior: 'contain' } },
    (stale || submitError) && h('p', { style: { ...errorStyle, margin: '0 0 16px' }, role: 'alert' },
      stale ? '配置已更新，请取消并重新打开编辑。' : submitError),
    removing
      ? h('p', { className: 'text-sm text-theme-secondary', style: { margin: 0, lineHeight: 1.8, overflowWrap: 'anywhere' } },
        `删除「${dialog.original.name}」？保存配置后，使用它的插件需要重新选择服务。`)
      : h('fieldset', { disabled: disabled || stale, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
        h(AiEditor, { ai: draft, source: dialog.source, schema: endpointSchema(schema), embedded: true,
          errors: { ...errors, ...localErrors },
          onUpdate: update => { setDraft(previous => editableAi(update(previous))); setLocalErrors({}); setSubmitError('') } }),
      ),
  ),
  h('div', { className: 'border-theme-divider', style: { ...line, justifyContent: 'flex-end', padding: '16px 20px', borderTopWidth: 1, flexShrink: 0 } },
    h('button', { type: 'button', className: 'btn-glass', disabled, onClick: close, 'data-initial-focus': removing ? true : undefined }, '取消'),
    h('button', { type: 'submit', className: 'btn-primary', disabled: disabled || stale }, removing ? '删除服务' : '确定'),
  ),
  )), document.body)
}

function ServiceSummary({ ai, isDefault, disabled, error, onEdit, onRemove, onDefault }) {
  const models = modelsOf(ai)
  return h('section', { className: 'rounded-xl border border-theme-divider', 'aria-label': `服务 ${ai.name}`,
    style: { padding: 20, display: 'grid', gap: 16, minWidth: 0 } },
    h('div', { style: { ...line, justifyContent: 'space-between' } },
      h('div', { style: { ...line, minWidth: 0 } },
        h('h4', { className: 'font-semibold text-theme', style: { margin: 0, overflowWrap: 'anywhere' } }, ai.name || '未命名服务'),
        isDefault && h('span', { className: 'text-xs text-theme-secondary bg-theme-item rounded-full', style: { padding: '3px 8px' } }, '默认服务'),
      ),
      h('div', { style: line },
        h('button', { type: 'button', className: 'btn-glass text-sm', disabled, onClick: onEdit, 'aria-label': `编辑服务 ${ai.name}` }, '编辑'),
        !isDefault && h('button', { type: 'button', className: 'btn-glass text-sm', disabled, onClick: onDefault, 'aria-label': `将 ${ai.name} 设为默认服务` }, '设为默认'),
        h('button', { type: 'button', className: 'btn-glass text-sm text-red-500', disabled, onClick: onRemove, 'aria-label': `删除服务 ${ai.name}` }, '删除'),
      ),
    ),
    h('span', { className: 'text-sm text-theme-muted', style: { overflowWrap: 'anywhere' } }, ai.baseUrl),
    h('div', { style: line },
      h('span', { className: 'text-xs text-theme-muted' }, `模型（${models.length}）`),
      ...models.slice(0, 4).map(model => h('code', { key: model, className: 'text-xs text-theme-secondary bg-theme-item rounded-lg',
        style: { padding: '4px 8px', overflowWrap: 'anywhere', maxWidth: '100%' } }, model)),
      models.length > 4 && h('span', { className: 'text-xs text-theme-muted' }, `还有 ${models.length - 4} 个`),
      !models.length && h('span', { className: 'text-xs text-theme-muted' }, '暂无模型，编辑服务后获取或添加。'),
    ),
    error && h('span', { style: errorStyle }, error),
  )
}

function ProviderPage() {
  const config = usePluginConfig()
  const [dialog, setDialog] = useState(null)
  const [, redraw] = useState(0)
  const latest = useRef(config)
  latest.current = config
  const editor = useRef(null)
  const operation = useRef(false)
  const lastAttempt = useRef(null)
  const addButton = useRef(null)
  // Server reloads (successful saves and 409s) reset both drafts and saved secret-source identities.
  if (!editor.current || editor.current.base !== config.value) {
    editor.current = { base: config.value, value: config.value,
      rows: (config.value?.ais ?? []).map(ai => ({ id: ++nextRowId, source: ai.name?.trim() })) }
  }
  const state = editor.current
  const ais = state.value?.ais ?? []
  const selectedDefault = ais.findIndex(ai => ai.name?.trim() === state.value?.default?.trim())
  const defaultIndex = selectedDefault < 0 ? 0 : selectedDefault
  const dirty = JSON.stringify(state.value) !== JSON.stringify(config.value)
  const errors = lastAttempt.current === state.value ? config.errors : {}
  const rowErrors = index => {
    const prefix = `ais.${index}`
    return Object.fromEntries(Object.entries(errors).filter(([path]) => path === prefix || path.startsWith(`${prefix}.`))
      .map(([path, error]) => [path === prefix ? '' : path.slice(prefix.length + 1), error]))
  }
  const stage = (value, rows = editor.current.rows) => {
    editor.current = { ...editor.current, value, rows }
    redraw(count => count + 1)
  }
  const open = (kind, id) => {
    const current = editor.current
    if (!current.value || latest.current.saving || operation.current) return
    const index = id === undefined ? undefined : current.rows.findIndex(row => row.id === id)
    if (index === -1) return
    setDialog({ kind, index, id, base: current.base, snapshot: current.value,
      original: index === undefined ? undefined : current.value.ais[index],
      source: index === undefined ? undefined : current.rows[index].source })
  }
  const confirm = entry => {
    const current = editor.current
    if (latest.current.saving || current.base !== dialog.base || current.value !== dialog.snapshot) return false
    const nextAis = [...current.value.ais]
    const rows = [...current.rows]
    let nextDefault = current.value.default
    if (dialog.kind === 'add') {
      nextAis.push(entry)
      rows.push({ id: ++nextRowId, source: undefined })
    } else {
      const index = rows.findIndex(row => row.id === dialog.id)
      if (index < 0) return false
      if (dialog.kind === 'remove') { nextAis.splice(index, 1); rows.splice(index, 1) }
      else nextAis[index] = entry
      if (nextDefault?.trim() === dialog.original.name?.trim()) nextDefault = entry?.name ?? ''
    }
    stage({ ...current.value, ais: nextAis, default: nextDefault }, rows)
    setDialog(null)
    return true
  }
  const setDefault = id => {
    const current = editor.current
    if (latest.current.saving || operation.current) return
    const index = current.rows.findIndex(row => row.id === id)
    if (index >= 0) stage({ ...current.value, default: current.value.ais[index].name?.trim() ?? '' })
  }
  const save = async () => {
    const current = editor.current
    if (dialog || operation.current || !current.value || current.base !== latest.current.value) return
    operation.current = true
    lastAttempt.current = current.value
    try {
      if (await latest.current.save(current.value)) cached = { at: 0, promise: undefined }
    } finally { operation.current = false }
  }

  return h('div', { className: 'card', style: { padding: 24 } },
    h('div', { style: { ...line, marginBottom: 24, gap: 12 } },
      h('div', { className: 'gradient-primary-br text-white rounded-xl', style: { display: 'grid', placeItems: 'center', width: 48, height: 48, flexShrink: 0 } }, h(Icon, { name: 'brain', size: 24 })),
      h('div', { style: { flex: '1 1 180px', minWidth: 0 } },
        h('h3', { className: 'text-lg font-semibold text-theme', style: { margin: 0 } }, 'AI 服务'),
        h('p', { className: 'text-sm text-theme-secondary', style: { margin: '4px 0 0' } }, '管理多个服务及各自的模型；其他插件在自己的设置中选择使用。'),
      ),
      h('button', { ref: addButton, type: 'button', className: 'btn-glass', disabled: !config.value || config.saving || !!config.error,
        style: { marginLeft: 'auto', flexShrink: 0 }, onClick: () => open('add') }, '添加服务'),
    ),
    config.error ? h('p', { style: errorStyle, role: 'alert' }, config.error)
      : !config.value ? h('p', { className: 'text-theme-muted' }, '加载中…')
        : !ais.length ? h('div', { className: 'rounded-xl bg-theme-item text-theme-muted', style: { padding: 32, textAlign: 'center', fontSize: 14 } }, '还没有服务，点击「添加服务」开始配置。')
          : h('div', { style: { display: 'grid', gap: 16 } }, ais.map((ai, index) => h(ServiceSummary, {
            key: state.rows[index].id, ai, isDefault: index === defaultIndex, disabled: config.saving,
            error: Object.values(rowErrors(index))[0],
            onEdit: () => open('edit', state.rows[index].id), onRemove: () => open('remove', state.rows[index].id),
            onDefault: () => setDefault(state.rows[index].id),
          }))),
    (errors[''] || errors.ais) && h('p', { style: errorStyle, role: 'alert' }, errors[''] || errors.ais),
    config.value && !config.error && h('div', { style: { ...line, justifyContent: 'flex-end', marginTop: 24 } },
      h('button', { type: 'button', className: 'btn-primary', disabled: config.saving || !dirty, onClick: save }, config.saving ? '保存中…' : '保存配置'),
    ),
    dialog && h(ServiceDialog, { dialog, schema: config.schema, errors: rowErrors(dialog.index),
      stale: dialog.base !== state.base || dialog.snapshot !== state.value, disabled: config.saving,
      onConfirm: confirm, onClose: () => setDialog(null), returnFocus: addButton }),
  )
}

export default function apply(ctx) {
  ctx.config(ProviderEditor)
  ctx.page({ id: 'settings', title: 'AI 服务', icon: 'brain', component: ProviderPage, settings: true })
  ctx.field('ai', AiField)
  ctx.field('ai-model', AiModelField)
}
