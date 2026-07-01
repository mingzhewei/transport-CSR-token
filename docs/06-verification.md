# 验证和排错

## Windows 用户注意

Windows PowerShell 中 `curl` 是 `Invoke-WebRequest` 的别名，行为和 Linux/macOS 的 curl 不同。推荐使用以下方式之一：

### 方式 1：使用 curl.exe（Windows 10+ 自带）

```powershell
curl.exe http://127.0.0.1:18787/healthz
```

### 方式 2：使用 Invoke-RestMethod（PowerShell 原生，输出更简洁）

```powershell
Invoke-RestMethod http://127.0.0.1:18787/healthz
```

### 方式 3：安装 Git Bash，使用真正的 curl

后文所有 `curl` 命令，Windows 用户请自行替换为 `curl.exe` 或 `Invoke-RestMethod`。

## 本地 mock 验证

这个命令会在本机启动 mock upstream、internal-bridge、external-client，验证完整转发链路：

```bash
npm run smoke:local
```

成功输出：

```text
smoke:local ok
```

新版 smoke 测试还会自动验证：本地认证失败返回 401、桥接 token 错误返回 401、CORS 预检、基础限流逻辑。

## 分层验证

### 1. 内部电脑能访问公司 API

在内部电脑上验证，不要在外部电脑上做这一步。

如果这一步失败，说明问题在公司 API、网络或真实 API key，不是转接器。

### 2. internal-bridge 本机健康检查

```bash
curl http://127.0.0.1:8787/healthz
```

### 3. 外部电脑能访问内部电脑的 Tailscale 地址

```bash
curl https://你的内部电脑Tailscale名称/healthz
```

如果失败，优先检查：

- 两台电脑是否登录同一个 Tailscale tailnet。
- 内部电脑是否运行了 `tailscale serve`。
- 公司网络是否阻止 Tailscale。

### 4. external-client 本机健康检查

```bash
curl http://127.0.0.1:8788/healthz
```

### 5. 外部电脑完整请求

```bash
curl http://127.0.0.1:8788/openai/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local-anything" \
  -d '{"model":"gpt-5.5","input":"只回复 OK"}'
```

## 常见问题

### env: node: No such file or directory

这个错误表示当前终端找不到 `node` 可执行文件。它不是项目代码错误。

先验证：

```bash
which node
node --version
which npm
npm --version
```

如果 `which npm` 有结果，但 `which node` 没结果，说明 npm 可能存在残留链接，但 Node 本体没有正确安装或没有正确链接。

macOS 使用 Homebrew 时，优先尝试：

```bash
brew install node
brew link node
node --version
npm --version
```

如果 Homebrew 提示 Node 已安装，但 `/opt/homebrew/bin/node` 仍不存在，可以检查：

```bash
brew list --versions node
brew link node --dry-run
```

如果 dry-run 只提示会覆盖 npm/npx 残留链接，可以执行：

```bash
brew link --overwrite node
node --version
npm --version
```

官方依据：

- Node.js 官方下载页：https://nodejs.org/en/download
- Homebrew node formula：https://formulae.brew.sh/formula/node

### cd..: command not found

返回上一级目录时，`cd` 和 `..` 中间需要有空格：

```bash
cd ..
```

另外，项目命令建议在项目根目录运行：

```bash
cd /Users/weimingzhe/Documents/转接器
npm run internal:start
```

### listen EADDRINUSE: address already in use 127.0.0.1:8787

这个错误表示 8787 端口已经被别的程序占用。

查看是谁占用：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

这台机器上之前的 `crs-bridge` 可能已经占用了 `127.0.0.1:8787`。如果你需要保留旧服务，可以把本项目改用备用端口 `127.0.0.1:18787`。

备用端口配置：

```bash
INTERNAL_LISTEN_ADDR=127.0.0.1:18787
```

然后重新启动：

```bash
npm run internal:start
```

### 外部电脑访问不到内部电脑

这通常不是代码问题，而是 Tailscale 没连通。先在 Tailscale 客户端里确认两台设备都在线。

### 返回 401

可能是 `BRIDGE_TOKEN` 不一致。内部电脑和外部电脑必须填写同一个 `BRIDGE_TOKEN`。

### Codex 不能用

先不要从 Codex 排查，先用 curl 验证 `http://127.0.0.1:8788/openai/responses`。curl 能通之后，再回到 Codex 配置。

### 流式输出不流动

当前程序对响应体做流式透传。如果仍然不流动，常见原因是上游 CRS 没有真正返回 `text/event-stream`，或者中间网络层对响应做了缓冲。
