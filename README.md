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

匿名模式目前不支持 `inlineData`、`fileData` 等图片或文件输入。

## 测试

```bash
npm test
```
