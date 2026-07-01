# Tailscale 说明

## 它是什么

Tailscale 可以理解为一个轻量的私有网络工具。它不是要求两台电脑在同一个局域网，而是让不同网络里的设备加入同一个私有 tailnet。

典型效果：

```text
外部电脑 Windows/Mac
  -> Tailscale
  -> 内部电脑 Windows/Mac
```

只要两台电脑都能访问互联网，并且都登录到同一个 Tailscale 账号或组织，它们就可以互相发现。

## 是否收费

Tailscale 官方价格页目前提供 Personal 免费计划。个人少量设备互联通常够用。价格策略可能变化，实施前以官方价格页为准。

官方页面：

- https://tailscale.com/pricing
- https://tailscale.com/kb/1151/what-is-tailscale
- https://tailscale.com/kb/1242/tailscale-serve
- https://tailscale.com/kb/1081/magicdns

## 为什么不用公网端口

不建议直接把 `internal-bridge` 暴露到公网：

- 需要路由器端口转发或公网 IP。
- 容易被扫描。
- 配置复杂，不符合“轻量”目标。

Tailscale 的好处是内部电脑只需要主动连到 Tailscale 网络，不需要公网 IP，也不需要端口转发。

## 这里建议怎么用

详细安装和配置步骤见：

- [安装并配置 Tailscale Serve](08-tailscale-serve-setup.md)

内部电脑运行：

```bash
npm run internal:start
```

然后通过 Tailscale Serve 把本机 `127.0.0.1:18787` 暴露给 tailnet 内设备：

```bash
tailscale serve --bg --https=443 http://127.0.0.1:18787
```

外部电脑访问的地址会类似：

```text
https://your-internal-computer.your-tailnet.ts.net/openai
```

这个地址只给同一个 tailnet 里的设备访问，不是公开互联网地址。
