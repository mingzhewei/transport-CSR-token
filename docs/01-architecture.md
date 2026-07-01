# 整体架构

## 目标

外部电脑上的软件不需要知道真实公司 API 的位置，也不需要保存公司 API key。它只访问本机的 `external-client`：

```text
外部软件
  -> http://127.0.0.1:18788/openai
  -> external-client
  -> Tailscale
  -> internal-bridge
  -> 公司 OpenAI 兼容 API
```

## 两个小程序

### internal-bridge

运行在内部电脑上，职责是：

- 保存真实公司 API key。
- 接收外部电脑转来的 OpenAI 兼容请求。
- 把请求转发到公司 API。
- 把公司 API 的响应原样返回给外部电脑。
- 对流式输出使用透传，不等完整结果生成完再返回。

### external-client

运行在外部电脑上，职责是：

- 在本机监听 `127.0.0.1:18788`。
- 对 Codex、VSCode、OpenAI SDK 看起来像普通 OpenAI 兼容服务。
- 把请求通过 Tailscale 转给内部电脑。
- 把内部电脑返回的内容继续返回给外部软件。

## 为什么需要 Tailscale

两台电脑即使都连在公网，也不代表它们能直接访问对方。家庭宽带、公司网络、酒店 Wi-Fi、运营商 NAT、防火墙都会阻止别人主动连进来。

Tailscale 的作用是给两台电脑建立一个私有覆盖网络。设备登录同一个 tailnet 后，会获得一个私有地址和 MagicDNS 名称。能直连时走点对点连接；直连失败时，Tailscale 会用 DERP 中继兜底。

## 当前边界

第一版只保证 `Responses API + gpt-5.5` 跑通。`/v1/chat/completions` 可以后续加，前提是确认公司 CRS 是否原生支持这个接口，或者我们做 Chat Completions 到 Responses 的转换。
