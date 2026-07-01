# 内部电脑配置

内部电脑是指能访问公司 CRS / OpenAI 兼容接口的那台电脑。

## 1. 安装 Node.js

当前项目使用纯 Node.js 标准库，没有第三方依赖。建议安装 Node.js 20 或更高版本。

验证：

```bash
node --version
```

## 2. 创建配置文件

复制示例配置：

```bash
cp .env.example .env
```

只保留并填写内部电脑需要的配置：

```bash
UPSTREAM_BASE_URL=https://crs.acerobotics.com/openai
UPSTREAM_API_KEY=这里填写真实公司APIKey
BRIDGE_TOKEN=这里填写一个强随机桥接Token
INTERNAL_LISTEN_ADDR=127.0.0.1:18787
DEFAULT_MODEL=gpt-5.5
MODEL_MAP=gpt-5.5=这里填写公司当前真实模型ID
LOG_LEVEL=info
LOG_FILE=./logs/internal-bridge.log
```

生成强 `BRIDGE_TOKEN`：

```bash
openssl rand -base64 32
```

程序启动时会读取 `BRIDGE_TOKEN`。它可以是任意值（包括简单口令如 `123456`），因为整个链路运行在 Tailscale 私有网络内。如果 token 为空，会给出提示但不阻止启动。

`UPSTREAM_API_KEY` 只应该放在内部电脑，不要放到外部电脑。

## 3. 启动 internal-bridge

内部电脑上启动顺序是固定的：**先启动 internal-bridge，再运行 tailscale serve**。因为 `tailscale serve` 只是把请求转发到 `127.0.0.1:18787`，如果这个端口上还没有程序在监听，外部访问会直接失败。

```bash
npm run internal:start
```

看到类似输出代表启动成功：

```text
{"level":"info","service":"internal-bridge","event":"server_listening",...}
```

本机验证：

```bash
curl.exe http://127.0.0.1:18787/healthz
```

确认返回 `{"ok":true,...}` 后，再进行下一步的 `tailscale serve`（见第 6 节）。

## 4. 日志位置

如果设置了：

```bash
LOG_FILE=./logs/internal-bridge.log
```

程序会同时把日志打印到终端并写入文件。日志是 JSON Lines，一行一个事件，方便你把两台电脑的日志同时发给我排查。

日志会记录：

- `request_id`：一次请求的唯一编号，会从外部端透传到内部端，两台电脑可以用它对照同一条请求。
- `request_start` / `request_finish`：请求开始和结束。
- `upstream_request_start` / `upstream_response_headers` / `upstream_response_stream_end`：转发到上游 API 的状态。
- HTTP 状态码、耗时、响应字节数、流式 chunk 数。

日志不会记录：

- 公司 API key。
- `Authorization` header。
- 请求正文和完整回答内容。

## 5. 其他可选环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `MODELS` | `/models` 返回的模型列表，逗号分隔（未设置 `MODEL_MAP` 时生效） | `DEFAULT_MODEL` |
| `MODEL_MAP` | 模型别名映射，格式 `别名=真实ID,别名2=真实ID2`。设置后 `/models` 只返回别名，转发 `/responses` 时自动把别名重写为真实 ID。公司变更模型 ID 时只改这里 | 空（不映射） |
| `RATE_LIMIT_RPM` | 每分钟每个客户端最大请求数，`0` 表示关闭 | `60` |
| `UPSTREAM_TIMEOUT_MS` | 等待上游响应头的超时时间（毫秒） | `120000` |
| `REQUEST_BODY_LIMIT_BYTES` | 最大请求体大小 | `25 * 1024 * 1024` |

## 6. 可选：限制哪些设备能访问

`tailscale serve` 默认向同一 tailnet 内所有设备开放。为了最小权限，建议在 Tailscale 控制台给外部电脑添加 ACL，只允许它访问内部电脑的 443/HTTPS serve：

```json
{
  "acls": [
    {
      "action": "accept",
      "src":    ["tag:external-laptop"],
      "dst":    ["your-internal-mac:443"]
    }
  ]
}
```

具体语法参考 Tailscale ACL 文档。

## 6. 通过 Tailscale Serve 暴露给外部电脑

确认 Tailscale 已登录，然后运行：

```bash
tailscale serve --bg --https=443 http://127.0.0.1:18787
```

之后在外部电脑上访问：

```bash
curl https://你的内部电脑Tailscale名称/healthz
```

如果能返回 `ok: true`，说明外部电脑已经能通过 Tailscale 找到内部电脑。
