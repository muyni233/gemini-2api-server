# Gemini Nexus 2API Server

一个可以单独复制、单独启动的 Gemini 原生 API 服务端。它使用 Gemini Nexus 的匿名 `StreamGenerate` 方案，把 Gemini Web 请求转换成 Google Gemini REST API 格式。

来源项目：[Gemini Nexus](https://github.com/goehou/Gemini-Nexus)。

服务端没有 API Key 鉴权，也不会校验请求里的 `Authorization` 或 `X-Goog-Api-Key`。默认只监听本机地址，适合本地运行或作为其他应用的上游。

## 运行

要求 Node.js 18 或更新版本，不需要安装任何运行时依赖：

```bash
cd gemini-2api-server
npm start
```

启动脚本会为 Gemini Web 页面较大的响应头预留足够空间；如果直接用 Node 命令启动，请保留同一个参数：

```bash
node --max-http-header-size=131072 src/index.js
```

默认监听 `http://127.0.0.1:8787`。可以用环境变量修改：

```bash
GEMINI_2API_HOST=0.0.0.0 GEMINI_2API_PORT=8787 npm start
```

Windows PowerShell：

```powershell
$env:GEMINI_2API_HOST = '0.0.0.0'
$env:GEMINI_2API_PORT = '8787'
npm start
```

也可以直接使用 Docker：

```bash
docker build -t gemini-nexus-2api .
docker run --rm -p 8787:8787 gemini-nexus-2api
```

## API

服务端只提供 Gemini 原生格式：

- `GET /v1beta/models`
- `GET /v1beta/models/{model}`
- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent?alt=sse`
- `POST /v1beta/models/{model}:countTokens`
- `GET /healthz`

`/v1/` 和省略版本前缀的 `/models/` 路径也支持。模型列表包括：

```text
gemini-3.8-flash
gemini-3.7-flash
gemini-3.5-flash
gemini-3.5-flash-thinking
gemini-3.1-pro
gemini-auto
gemini-flash-lite
```

最小请求示例：

```bash
curl http://127.0.0.1:8787/v1beta/models/gemini-3.8-flash:generateContent \
  -H 'Content-Type: application/json' \
  -d '{
    "contents": [
      {"role":"user","parts":[{"text":"你好，请用一句话介绍自己。"}]}
    ]
  }'
```

## Tool calling

服务端接受 Gemini 格式的 `tools[].functionDeclarations`、`toolConfig.functionCallingConfig`，并能处理后续请求中的 `functionResponse`。

匿名 Gemini Web 上游本身只返回文本，因此这里使用协议兼容桥：工具声明会被写入提示词，模型输出的 `<function_call>{...}</function_call>` 会转换为 Gemini `functionCall` part。调用方仍然负责执行函数，再把结果作为下一次请求的 `functionResponse` 发回。没有工具声明时，普通文本请求不会经过工具解析。

服务端实现了 Gemini `inlineData` 和 `fileData` 的页面令牌获取、resumable upload 和文件引用注入流程。但当前匿名 `StreamGenerate` 会对这些引用返回 `BardErrorInfo[1003]`；也就是说，匿名模式可以建立上传会话，却不能稳定让匿名模型消费媒体。要使用媒体输入，需要接入带有效 Gemini Web Cookie 的会话方案，或者改用官方 Gemini API。纯文本请求不受这项限制。

上传能力依赖 Gemini Web 当前的页面字段和上传协议；如果 Google 改动页面契约，上传可能暂时失效。

## 响应延迟

`StreamGenerate` 不是标准的逐 token SSE。上游可能先返回 HTTP 头和协议元数据，过一段时间才返回第一段可见文本。首个请求还要获取当前页面的 build label；服务端会缓存它，但模型生成耗时仍由 Gemini Web 上游决定。这个服务端无法把上游的首字延迟压缩成官方 API 的水平。

## 测试

```bash
npm test
```
