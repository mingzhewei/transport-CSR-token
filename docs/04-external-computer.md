# 外部电脑配置

外部电脑是指运行 Codex、VSCode、脚本或其他 OpenAI 兼容客户端的电脑。

## 1. 安装 Node.js

当前项目使用 Node.js 运行：

```bash
node --version
```

## 2. 创建配置文件

复制示例配置：

```bash
cp .env.example .env
```

只保留并填写外部电脑需要的配置：

```bash
REMOTE_BASE_URL=https://你的内部电脑Tailscale名称/openai
BRIDGE_TOKEN=和内部电脑一致的桥接Token
EXTERNAL_LISTEN_ADDR=127.0.0.1:8788
EXTERNAL_API_KEY=你的本地APIKey
LOG_LEVEL=info
LOG_FILE=./logs/external-client.log
```

`REMOTE_BASE_URL` 不是公司 CRS 地址，而是内部电脑通过 Tailscale 暴露出来的地址。

`EXTERNAL_API_KEY` 建议始终设置。如果留空，本机任何进程都可以调用 `external-client` 进而使用公司 API。单人电脑可以留空，多人电脑或敏感环境必须设置。

## 3. 启动 external-client

```bash
npm run external:start
```

看到类似输出代表启动成功：

```text
{"level":"info","service":"external-client","event":"server_listening",...}
```

## 4. 日志位置

如果设置了：

```bash
LOG_FILE=./logs/external-client.log
```

外部电脑会记录本机软件调用 `external-client` 的状态，以及它转发给内部电脑的状态。

排查问题时，最有用的是把外部电脑的 `external-client.log` 和内部电脑的 `internal-bridge.log` 一起提供。两边日志里的同一条请求会使用相同的 `request_id`。

## 5. 其他可选环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `RATE_LIMIT_RPM` | 每分钟每个客户端最大请求数，`0` 表示关闭 | `60` |
| `UPSTREAM_TIMEOUT_MS` | 等待内部-bridge 响应头的超时时间（毫秒） | `120000` |
| `REQUEST_BODY_LIMIT_BYTES` | 最大请求体大小 | `25 * 1024 * 1024` |

## 6. 验证本机接口

```bash
curl http://127.0.0.1:8788/healthz
```

验证模型列表：

```bash
curl http://127.0.0.1:8788/openai/models
```

验证 Responses API：

```bash
curl http://127.0.0.1:8788/openai/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $EXTERNAL_API_KEY" \
  -d '{"model":"gpt-5.5","input":"只回复 OK"}'
```

如果 `EXTERNAL_API_KEY` 留空，则 `Authorization` 可以填任意值。

## 7. 调试端点（外部电脑排错用）

外部电脑出问题时，先调这两个端点定位"断在哪一跳"，不用登录内部电脑：

```bash
# 自测整条链路：自己 -> internal-bridge /healthz -> internal-bridge /openai/models
curl http://127.0.0.1:8788/debug/probe \
  -H "Authorization: Bearer $EXTERNAL_API_KEY"
```

返回每一跳的 `ok` / `status` / `duration_ms`。任何一跳 `ok=false` 就说明断点在那里。

```bash
# 查看最近的错误记录（环形缓冲，最近 50 条）
curl http://127.0.0.1:8788/debug/recent-errors \
  -H "Authorization: Bearer $EXTERNAL_API_KEY"
```

此外，当 external-client 无法连到 internal-bridge 时，返回的 502/504 错误体里会带 `hint` 字段，直接给出排查方向。
