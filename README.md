# Gemini Nexus 2API Server

将 Gemini Web 的匿名 `StreamGenerate` 接口转换成 Gemini REST 格式的独立服务。来源：[Gemini Nexus](https://github.com/goehou/Gemini-Nexus)。无运行时依赖。

这是非官方 Web bridge。模型名称是兼容别名，不代表已验证的后端模型版本；匿名 Pro 别名可能回落到 Flash。服务默认仅监听本机，上游始终不携带 Google Cookie。

## 启动

使用最新补丁版 Node.js 22 LTS（至少 22.19）或 24 LTS（至少 24.6），推荐 24 LTS：

```bash
npm start
```

默认地址：`http://127.0.0.1:8787`。启动命令中的 `--max-http-header-size=131072` 用于兼容 Gemini 首页较大的响应头；自行调用模块时也应保留。服务接收客户端请求的头部仍限制为 16 KiB。

Windows PowerShell 配置示例：

```powershell
$env:GEMINI_2API_PORT = '8787'
$env:GEMINI_2API_API_KEY = 'replace-with-a-long-random-secret'
npm start
```

Linux/macOS：

```bash
GEMINI_2API_PORT=8787 GEMINI_2API_API_KEY='replace-with-a-long-random-secret' npm start
```

### Docker

```bash
docker build -t gemini-nexus-2api .
docker run --rm -p 127.0.0.1:8787:8787 gemini-nexus-2api
```

容器使用 Node.js 24 和非 root 用户，带 `/healthz` 存活检查。需要局域网访问时调整端口绑定，并通过 `-e GEMINI_2API_API_KEY=...` 或反向代理控制访问。`/healthz` 只检查本地服务，不证明 Google 当前可用。

## 配置

| 环境变量                      | 默认值            | 作用                                                                                                                                     |
| ----------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_2API_HOST`            | `127.0.0.1`       | 监听地址；容器内为 `0.0.0.0`                                                                                                             |
| `GEMINI_2API_PORT`            | `8787`            | 端口；未设置时也读取 `PORT`                                                                                                              |
| `GEMINI_2API_API_KEY`         | 未设置            | 可选的本地 API 访问密钥，与 Google 登录无关                                                                                              |
| `GEMINI_2API_ALLOWED_ORIGINS` | 本机 HTTP(S) 来源 | 允许的浏览器来源，逗号分隔，如 `https://chat.example.com,http://localhost:3000`；显式设置 `*` 开放所有来源，空值禁止所有带 Origin 的请求 |
| `GEMINI_2API_TIMEOUT_MS`      | `180000`          | 生成总超时，覆盖构建号查询、重试和流读取                                                                                                 |
| `GEMINI_2API_MAX_CONCURRENT`  | `8`               | 同时进行的生成请求数；满载返回 429，不在内存中排队                                                                                       |
| `GEMINI_2API_DEBUG`           | 未设置            | 设为 `1` 输出构建号刷新失败原因；不记录提示词和 Cookie                                                                                   |

未设置密钥时，API 无鉴权；设置后支持 `Authorization: Bearer ...`、`X-Goog-Api-Key`、`X-Api-Key` 或 `?key=...`，优先使用请求头，避免 URL 被访问日志记录。健康检查和 OPTIONS 预检不要求密钥，但仍受浏览器来源规则约束。

默认浏览器来源允许 `http(s)://localhost`、`127.0.0.1`、`[::1]` 的任意端口。命令行及服务端客户端通常不发送 `Origin`，不受跨域规则限制。

需要代理时，Node 启动前设置环境变量：

```powershell
$env:NODE_USE_ENV_PROXY = '1'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
npm start
```

代理采用 Node 的内置机制；仅设置 `HTTPS_PROXY` 未必会启用 `fetch` 代理。参见 [Node CLI 文档](https://nodejs.org/api/cli.html#node_use_env_proxy1)。项目不会自动读取 `.env` 文件。

## 接口

```text
GET  /healthz
GET  /v1beta/models
GET  /v1beta/models/{model}
POST /v1beta/models/{model}:generateContent
POST /v1beta/models/{model}:streamGenerateContent?alt=sse
POST /v1beta/models/{model}:countTokens
```

`/v1/` 和省略版本的 `/models/` 路径也可用。`streamGenerateContent` 始终返回 SSE，包括未传 `alt=sse` 时；不支持 Google 的 JSON 数组流格式。SSE 无 OpenAI `[DONE]` 哨兵，正常完成时发送 `finishReason: STOP`；中途失败发送包含 `error` 的事件后结束，不发送成功标记。

```bash
curl http://127.0.0.1:8787/v1beta/models/gemini-3.8-flash:generateContent \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'
```

启用密钥后，在示例中添加 `-H 'X-Goog-Api-Key: your-key'`。Windows PowerShell 建议使用：

```powershell
$body = @{ contents = @(@{ role = 'user'; parts = @(@{ text = '你好' }) }) } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/v1beta/models/gemini-3.8-flash:generateContent' `
  -Method Post -ContentType 'application/json; charset=utf-8' `
  -Headers @{ 'X-Goog-Api-Key' = $env:GEMINI_2API_API_KEY } `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

### 模型及能力边界

| 兼容别名                                                   | Web 模式                  | 默认 `think` |
| ---------------------------------------------------------- | ------------------------- | ------------ |
| `gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.5-flash` | FAST（相同映射）          | 4            |
| `gemini-3.5-flash-thinking`                                | THINKING                  | 0            |
| `gemini-3.1-pro`、`gemini-3.1-pro-enhanced`                | PRO；匿名时不保证真实 Pro | 4            |
| `gemini-auto`                                              | AUTO                      | 4            |
| `gemini-3.5-flash-thinking-lite`                           | FAST_DYNAMIC_THINKING     | 0            |
| `gemini-flash-lite`                                        | FLASH_LITE                | 4            |

可添加 `@think=0` 到 `@think=4` 后缀，例如 `gemini-3.5-flash-thinking@think=2`。这是来自逆向协议的实验性控制，不承诺实际思考预算；`enhanced` 也不代表已获得额外账号权益。HTTP 接口会将越界整数后缀限制到 0–4，无法解析的后缀忽略并回退默认档位；未知基础模型仍返回 404。响应的 `modelVersion` 固定为 `gemini-web-unverified`，避免把请求别名当成已验证版本。

也可以直接在请求体传入 `reasoning_effort`，服务会映射到相同的上游字段，无需修改模型名称：

```json
{
    "contents": [{ "role": "user", "parts": [{ "text": "分析这个问题" }] }],
    "reasoning_effort": "high"
}
```

| `reasoning_effort` / `reasoningEffort` / `reasoning.effort` | Web `think` |
| ----------------------------------------------------------- | ----------- |
| `none`、`minimal`                                           | 4（最浅）   |
| `low`                                                       | 3           |
| `medium`                                                    | 2           |
| `high`                                                      | 1           |
| `xhigh`、`max`                                              | 0（最深）   |

Gemini 原生 `thinkingLevel` 使用单独的映射，`HIGH` 对应最深的 `0`：

| `generationConfig.thinkingConfig.thinkingLevel` | Web `think`          |
| ----------------------------------------------- | -------------------- |
| `MINIMAL`                                       | 4                    |
| `LOW`                                           | 3                    |
| `MEDIUM`                                        | 2                    |
| `HIGH`                                          | 0（最深）            |
| `THINKING_LEVEL_UNSPECIFIED`                    | 保留后缀或模型默认值 |

```json
{
    "contents": [{ "role": "user", "parts": [{ "text": "分析这个问题" }] }],
    "generationConfig": { "thinkingConfig": { "thinkingLevel": "HIGH" } }
}
```

取值不区分大小写，也支持原生字段的 snake_case 拼写。这只增加思考参数的兼容，不增加 Chat Completions 或 Responses 路由；请求内容仍使用 Gemini `contents` 格式。字段来源见 [OpenAI reasoning effort](https://developers.openai.com/api/docs/guides/reasoning) 和 [Gemini ThinkingConfig](https://ai.google.dev/api/generate-content#ThinkingConfig)。

上表是本项目约定的相对档位映射，不承诺跨模型等效预算；`none` 映射到最浅档，不保证完全关闭思考。取值为空、非法或不认识时尝试下一个有效配置；`null`、`auto`、`default` 和原生 `THINKING_LEVEL_UNSPECIFIED` 表示不覆盖默认。优先级为：`reasoning_effort` → `reasoningEffort` → `reasoning.effort` → 原生 `thinkingLevel` → URL `@think=` → 模型默认值。原生参数同层优先 camelCase，再尝试 snake_case，优先级不受 JSON 属性顺序影响。冲突时采用优先级较高的有效值，继续处理请求。`countTokens` 使用相同归一化规则，思考档位不改变本地提示词计数。

JSON 和 SSE 响应的 `X-Gemini-Thinking-Mode` 响应头给出归一化后的思考档位。

- 仅支持文本；`inlineData`、`fileData` 和混合数据 Part 会在请求上游前被拒绝。
- 系统提示词和多轮历史被折叠成单次文本请求，不具备原生角色隔离、缓存和会话连续性。
- `tools[].functionDeclarations`、`functionCall` 和 `functionResponse` 使用提示词桥接。支持 AUTO、ANY、NONE 和函数名称限制；有效 ANY 配置未得到有效调用时返回 502。畸形声明会被丢弃，重复名称保留第一个有效声明；错误的工具模式或完全无效的白名单会停用工具，保留普通文字回答，避免意外允许所有函数。函数由客户端执行，执行前仍须校验参数及操作权限。这里不提供原生约束解码或完整 JSON Schema 校验。
- 工具调用请求先缓冲完整输出再生成 functionCall，避免把半个 JSON 发给客户端。正文中带解释的调用示例不会转换成函数执行请求。
- `generationConfig` 仅映射上述 `thinkingConfig.thinkingLevel`，其余字段忽略；输出保持单个文本候选，不提供思考摘要。温度、输出上限、stop、JSON Schema、精确 `thinkingBudget`、多模态输出等不能可靠透传。safetySettings、cachedContent、Google Search/codeExecution 等内置工具配置也会被忽略；成功响应不代表这些约束已生效，Web 自发搜索也不等同于 API 的可配置 grounding。
- `countTokens` 支持 `contents` 或 `generateContentRequest`，同时提供时优先有效的嵌套对象；冗余模型字段以 URL 为准。它及 `usageMetadata` 使用本地 Unicode 字符数除以 4 的粗估，包括桥接提示词；中文、代码等误差可能很大，不能用于计费或精确预算。响应头 `X-Gemini-Token-Count: estimated` 标注此限制。

## 运行边界与错误

请求体限制 2 MiB；上游响应累计限制 16 MiB，单帧限制 4 Mi 个 UTF-16 单元；SSE 待发送队列限制 1 MiB。上下游流都有背压和取消处理，客户端断开会停止对应生成。收到 SIGINT/SIGTERM 后最多等待 10 秒，随后中止活动请求。

上游构建号成功缓存 1 小时，获取失败后缓存回退值 30 秒；并发刷新合并为一次请求。仅 HTTP 405 或 RPC 1052 且尚未出现候选文本时刷新构建号并重试一次；不会在已经输出文本后重新生成。429 不自动重试，并尽可能保留 `Retry-After`。

| HTTP 状态 | 常见原因                                                     |
| --------- | ------------------------------------------------------------ |
| 400 / 404 | 损坏的 JSON、缺失内容、不支持的媒体、未知基础模型或路径      |
| 401 / 403 | 本地访问密钥错误 / 浏览器来源未允许                          |
| 413       | 请求体超过限制                                               |
| 429       | 本地并发已满或上游配额耗尽（RPC 1037）                       |
| 502       | 协议错误、空文本、截断、候选改写、工具桥接失败等             |
| 503       | 上游临时错误（1013）、网络被临时限制（1060），或发送队列限制 |
| 504       | 请求超时                                                     |

SSE 一旦已经开始，上述状态通过流内的 `error.code` 表示，HTTP 状态仍是 200；客户端应读取最终事件。

## 测试与上游探测

```bash
npm test
npm run test:coverage
npm run probe:upstream
npm run probe:upstream -- gemini-3.5-flash-thinking@think=2
```

测试完全离线。探测命令会向 Google 发出一条固定短提示词，输出构建号、耗时、更新数和错误分类，不输出原始 RPC 或敏感会话数据；默认上限 45 秒。探测成功只证明该别名当前能返回文本，不能证明后端型号。

模块调用可通过 `createGemini2ApiServer({ sendMessage, maxBodyBytes, requestTimeoutMs, maxConcurrentRequests, maxPendingSseBytes, apiKey, allowedOrigins })` 配置。关闭时使用 `await server.shutdown({ gracePeriodMs: 10000 })`。自定义 provider 成功时返回文本或 `{ text }`，失败时抛出异常；应响应传入的 AbortSignal，并等待 `onUpdate(text)` 返回的 Promise（`text` 为累计文本）。
