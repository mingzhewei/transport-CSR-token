# Codex / OpenAI 兼容配置

外部软件只需要访问外部电脑本机的 `external-client`。

## Codex 示例

```toml
model_provider = "crs"
model = "gpt-5.5"
model_reasoning_effort = "high"
disable_response_storage = true
preferred_auth_method = "apikey"

[model_providers.crs]
name = "crs"
base_url = "http://127.0.0.1:18788/openai"
wire_api = "responses"
requires_openai_auth = true
KEY = "local-anything"
```

这里的 `KEY` 不是公司真实 API key。外部电脑只需要给本机 `external-client` 一个本地 key。

如果 `.env` 里设置了 `EXTERNAL_API_KEY`，那么这里的 `KEY` 必须和它一致。如果 `EXTERNAL_API_KEY` 留空，那么 `external-client` 不校验这个 key（仅建议单人电脑使用）。

## OpenAI SDK 思路

只要客户端允许设置 `baseURL`，就设置为：

```text
http://127.0.0.1:18788/openai
```

模型名使用：

```text
gpt-5.5
```

## 路径兼容

当前支持：

```text
GET  /openai/models
GET  /v1/models
POST /openai/responses
POST /v1/responses
```

如果某个 IDE 只支持 `/v1/chat/completions`，需要第二阶段增加兼容层。
