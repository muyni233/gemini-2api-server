# Gemini Nexus 2API Server

独立的 Gemini 原生 API 服务端，复用 Gemini Web 的匿名 `StreamGenerate` 接口。项目来源：[Gemini Nexus](https://github.com/goehou/Gemini-Nexus)。

这是无鉴权服务，默认只监听本机。不要直接暴露到公网。

## 启动

要求 Node.js 18+，无运行时依赖：

```bash
npm start
```

默认地址：`http://127.0.0.1:8787`

```bash
GEMINI_2API_HOST=0.0.0.0 GEMINI_2API_PORT=8787 npm start
```

Windows PowerShell：

```powershell
$env:GEMINI_2API_HOST = '0.0.0.0'
$env:GEMINI_2API_PORT = '8787'
npm start
```

Docker：

```bash
docker build -t gemini-nexus-2api .
docker run --rm -p 8787:8787 gemini-nexus-2api
```

## 接口

```text
GET  /healthz
GET  /v1beta/models
GET  /v1beta/models/{model}
POST /v1beta/models/{model}:generateContent
POST /v1beta/models/{model}:streamGenerateContent?alt=sse
POST /v1beta/models/{model}:countTokens
```

`/v1/` 和省略版本的 `/models/` 路径也可用。服务端忽略 API Key、`Authorization` 和 `X-Goog-Api-Key`。

请求示例：

```bash
curl http://127.0.0.1:8787/v1beta/models/gemini-3.8-flash:generateContent \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'
```

## 限制

- 上游是 Gemini Web，不是官方 Gemini API。`StreamGenerate` 不是标准逐 token SSE，首字延迟由上游决定。
- `tools[].functionDeclarations`、`functionResponse` 和 `functionCall` 可以使用，但工具调用是提示词桥接，不是上游原生 Function Calling；函数仍由客户端执行。
- 这个独立无鉴权服务只支持文本；需要媒体时使用官方 API 或单独的 Cookie 会话 Web bridge。
- 请求体默认限制为 2 MiB；服务无鉴权，请自行限制网络访问。

## 测试

```bash
npm test
```
