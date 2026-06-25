# 轻量大模型转接器

这个项目提供两个小程序：

- `internal-bridge`：运行在能访问公司内部大模型 API 的电脑上。
- `external-client`：运行在外部电脑上，对 Codex、VSCode、脚本等软件伪装成一个 OpenAI 兼容接口。

推荐链路：

```text
Codex / VSCode / OpenAI SDK
  -> http://127.0.0.1:8788/openai
  -> external-client
  -> Tailscale 私有通道
  -> internal-bridge
  -> 公司 CRS OpenAI 兼容接口
```

第一版支持：

- `GET /healthz`
- `GET /openai/models`
- `GET /v1/models`
- `POST /openai/responses`
- `POST /v1/responses`
- Responses API 流式输出透传

## 快速验证

本机 mock 测试不访问真实公司 API：

```bash
npm run smoke:local
```

模拟一台外部电脑通过 internal-bridge 访问大模型（含动态模型映射、debug 探测验证）：

```bash
npm run simulate          # 常驻运行，可用 curl 体验
SIMULATE_ONCE=1 npm run simulate   # 跑完自动验证即退出

## 文档

- [整体架构](docs/01-architecture.md)
- [Tailscale 说明](docs/02-tailscale.md)
- [安装并配置 Tailscale Serve](docs/08-tailscale-serve-setup.md)
- [内部电脑配置](docs/03-internal-computer.md)
- [外部电脑配置](docs/04-external-computer.md)
- [Codex / OpenAI 兼容配置](docs/05-openai-compatible-config.md)
- [验证和排错](docs/06-verification.md)
- [可选：安装 Go](docs/07-install-go-optional.md)
