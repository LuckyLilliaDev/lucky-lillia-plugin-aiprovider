# @luckylillia/plugin-aiprovider

LuckyLillia Bot 的「AI 服务」插件。集中管理 OpenAI 兼容接口的地址、API Key 和模型列表，通过 `ctx.ai` 为其他插件提供对话、流式回答和 API 请求。每个调用插件可以选择不同的服务和模型；本插件本身不注册聊天指令。

## 安装与配置

发布到 npm 后，可以下载插件压缩包：

```sh
npm pack @luckylillia/plugin-aiprovider
```

在 Bot WebUI 的「插件市场」安装 AI 服务。安装后，到「插件列表」信任并启用「AI 服务」，批准加载插件界面。如果插件已收录到所用市场，也可以直接从市场安装。

1. 打开「AI 服务」设置，点击「添加服务」。填写服务名称、接口地址和 API Key。接口地址填到版本号，例如 `https://api.deepseek.com/v1`，插件会自动拼接 `/chat/completions` 等路径。
2. 点击「自动获取」读取模型列表，或手动添加服务商提供的模型 ID。需要处理图片时，请选择支持图片输入的模型。
3. 在弹窗中选择模型并测试，点击「确定」返回列表。按需设置默认服务，最后点击页面外层的「保存配置」。测试只使用当前草稿，不会自动保存。
4. 在使用 AI 的插件中选择服务和模型。未指定时，使用默认服务和它的首个模型；默认服务为空或不存在时，使用列表中的第一个服务。

请求通过 Bot 的 HTTP 服务发送，可沿用内置「代理」插件的配置；单个服务可以关闭「走代理」。API Key 可以留空；若服务商要求其他认证头，可通过「额外的请求头」配置。

## 给其他插件使用

`ctx.ai` 的类型由本包提供。开发调用方时安装类型依赖：

```sh
npm install -D @luckylillia/plugin-sdk@^1.0.1 @luckylillia/plugin-aiprovider@^1.0.0
```

在调用方的 `package.json` 中合并以下配置：

```json
{
  "peerDependencies": {
    "@luckylillia/plugin-sdk": "^1.0.1",
    "@luckylillia/plugin-aiprovider": "^1.0.0"
  },
  "llbot": {
    "dependencies": {
      "@luckylillia/plugin-aiprovider": "^1.0.0"
    },
    "service": {
      "required": ["ai", "commands"]
    }
  }
}
```

`peerDependencies` 声明 API 兼容范围，`llbot.dependencies` 声明宿主需要安装的插件包，代码中的 `inject` 等待服务就绪。市场自动补装依赖需要该包已被市场收录；通过 npm 安装开发依赖不会在 Bot 中自动启用服务插件。

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

对话选项中的 `ai` 是配置的服务名称，`model` 是模型 ID。图片可以用 `{ type: 'image', data }` 传入 `Uint8Array` 或 `ArrayBuffer`；QQ 图片建议先下载字节，避免服务商无法读取临时链接。服务错误可按 `AiError.kind` 区分配置、认证、余额、限流和网络等原因；`AiError` 是公开类型，判断时不要使用 `instanceof`。

## 开发

在本插件目录执行即可，无需先检出或构建 Bot 仓库：

```sh
npm install
npm test
npm run build
npm pack --dry-run
```

开发依赖使用 npm 上的 SDK 和 Cordis。测试通过 SDK 测试工具启动本地模拟 AI 接口，不需要真实 API Key。`npm run dev` 持续编译源码；`prepack` 会在打包前重新构建。发布包包含 `lib/`、`src/` 和 `webui/`，后端入口为 `lib/index.js`，公开类型为 `lib/types.d.ts`。

需要与 Bot 联调时，将插件目录放入 Bot 的 `data/plugins/`，或启动 Bot 时通过 `--plugin-dir <插件父目录>` 添加扫描目录，再在 WebUI 中重新扫描并启用。
