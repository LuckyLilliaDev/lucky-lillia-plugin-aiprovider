# @luckylillia/plugin-aiprovider

幸运莉莉娅 的「AI 服务」插件。集中管理 OpenAI 兼容接口的地址、API Key 和模型列表，通过 `ctx.ai` 为其他插件提供对话、流式回答和 API 请求。每个调用插件可以选择不同的服务和模型。

## 给其他插件使用

`ctx.ai` 的类型由本包提供。开发调用方时安装类型依赖：

```sh
npm install -D @luckylillia/plugin-sdk @luckylillia/plugin-aiprovider
```

下面的例子注册一个提问指令，模型选项会在 WebUI 中显示服务和模型下拉框：

```ts
import { Context, h, Schema } from '@luckylillia/plugin-sdk'
import type { AiModelSelection } from '@luckylillia/plugin-aiprovider'

export const inject = ['ai', 'commands']

export interface Config {
  model: AiModelSelection
}

export const Config: Schema<Config> = Schema.object({
  model: Schema.object({
    ai: Schema.string().default(''),
    model: Schema.string().default(''),
  }).role('ai-model').description('使用的 AI 模型'),
})

export function apply(ctx: Context, config: Config) {
  ctx.command('问 <question:text>', '问 AI').action(async (_, question) => {
    const { text } = await ctx.ai.chat(question, config.model)
    return h.text(text)
  })
}
```

类型导入会为 `Context` 补充 `ai`，编译后不会引入服务实现。如果不需要单独引用类型，也可以写 `import type {} from '@luckylillia/plugin-aiprovider'`。指令前缀遵循 Bot 的「指令」设置。

| 接口 | 用途 |
| --- | --- |
| `list()` / `get(name?)` | 查询已配置的服务和模型，不返回 API Key |
| `chat(input, options?)` | 发送字符串或消息数组，返回 `text`、`usage`、`reasoning` 和原始响应等 |
| `stream(input, options?)` | 返回 `AsyncIterable<string>`，逐段读取回答 |
| `request(ai, path, init?)` | 调用所选服务的其他接口，自动带上认证和配置的请求头 |

对话选项中的 `ai` 是配置的服务名称，`model` 是模型 ID。图片可以用 `{ type: 'image', data }` 传入 `Uint8Array` 或 `ArrayBuffer。


