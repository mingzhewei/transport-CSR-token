# 安装并配置 Tailscale Serve

## 先回答核心问题

`tailscale serve` 不需要单独安装。它是 Tailscale 客户端自带的命令行功能。

但是，电脑上必须先安装并登录 Tailscale 客户端：

- 内部电脑：必须安装 Tailscale，并且需要运行 `tailscale serve`。
- 外部电脑：必须安装 Tailscale，但通常不需要运行 `tailscale serve`，只需要访问内部电脑的 Tailscale 地址。

官方依据：

- Tailscale CLI 文档说明 Tailscale client includes a built-in CLI。
- Tailscale Serve 文档说明 `tailscale serve` 用来把本机服务分享给 tailnet 内设备。
- Tailscale macOS / Windows 安装文档分别说明安装客户端并登录。

官方文档：

- https://tailscale.com/docs/reference/tailscale-cli
- https://tailscale.com/docs/reference/tailscale-cli/serve
- https://tailscale.com/docs/install/mac
- https://tailscale.com/docs/install/windows
- https://tailscale.com/docs/how-to/quickstart

## 这套项目里 Serve 的位置

```text
外部电脑
  - 安装 Tailscale
  - 运行 external-client
  - 不需要 tailscale serve

内部电脑
  - 安装 Tailscale
  - 运行 internal-bridge，监听 127.0.0.1:18787
  - 运行 tailscale serve，把 127.0.0.1:18787 分享给外部电脑
```

## 启动顺序（重要）

内部电脑上**必须先启动 internal-bridge，再运行 tailscale serve**：

```text
第 1 步：npm run internal:start      ← 让 127.0.0.1:18787 开始监听
第 2 步：tailscale serve ...          ← 把已在监听的端口分享出去
```

原因：`tailscale serve` 本质是一个反向代理，它只负责把 tailnet 的请求转发到 `127.0.0.1:18787`。如果这个端口上还没有程序在监听（即没先启动 internal-bridge），外部电脑访问时只会收到连接错误（502 / connection refused）。

反过来的影响：

- 顺序反了（先 serve 后启动服务）：serve 配置能建立，但在 internal-bridge 起来之前，外部访问都会失败。等 internal-bridge 起来后会自动恢复正常，不需要重开 serve。
- internal-bridge 中途停了：serve 配置还在，但外部访问会失败，直到 internal-bridge 重新启动。

所以正式运行时，建议把 internal-bridge 配成后台常驻（PM2 / NSSM），保证它一直在监听，serve 只需配一次。

## macOS 安装 Tailscale

推荐方式：从 Tailscale 官方下载 Standalone 版本。

```text
https://tailscale.com/download
```

安装后：

1. 打开 Tailscale。
2. 登录你的账号。
3. 按提示允许 VPN 配置。
4. 确认这台 Mac 出现在 Tailscale 管理后台的 Machines 列表里。

如果你使用 Homebrew，也可以尝试：

```bash
brew install --cask tailscale
open -a Tailscale
```

验证 CLI 是否可用：

```bash
tailscale version
tailscale status
```

如果 macOS 提示 `tailscale: command not found`，说明 CLI 没进 PATH。可以直接使用 Tailscale App 内置命令：

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale version
/Applications/Tailscale.app/Contents/MacOS/Tailscale status
```

为了后面命令更短，可以添加 alias：

```bash
echo 'alias tailscale="/Applications/Tailscale.app/Contents/MacOS/Tailscale"' >> ~/.zshrc
source ~/.zshrc
tailscale version
```

## Windows 安装 Tailscale

推荐方式：从 Tailscale 官方下载 Windows 安装程序。

```text
https://tailscale.com/download
```

安装后：

1. 右下角系统托盘会出现 Tailscale 图标。
2. 右键图标，选择登录。
3. 用同一个 Tailscale 账号登录。
4. 确认这台 Windows 电脑出现在 Tailscale 管理后台的 Machines 列表里。

验证 CLI 是否可用，在 PowerShell 里运行：

```powershell
tailscale version
tailscale status
```

如果 PowerShell 提示找不到命令，可以用完整路径：

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" version
& "$env:ProgramFiles\Tailscale\tailscale.exe" status
```

## 两台电脑都要做的检查

在内部电脑和外部电脑都运行：

```bash
tailscale status
```

你应该能看到两台设备都在线。

如果看不到对方，优先检查：

- 是否登录了同一个 Tailscale 账号或同一个 tailnet。
- Tailscale 客户端是否显示 Connected。
- 是否在 Tailscale 管理后台看到了两台 Machines。

## 内部电脑启动 internal-bridge（第 1 步）

先在内部电脑启动项目的内部桥接程序：

```bash
npm run internal:start
```

本机验证（Windows 用 curl.exe）：

```bash
curl.exe http://127.0.0.1:18787/healthz
```

成功时会返回类似（字段以实际输出为准）：

```json
{"ok":true,"service":"internal-bridge","default_model":"gpt-5.5","model_map_enabled":false}
```

看到这个响应，说明 `127.0.0.1:18787` 已经在监听，可以进行下一步。

## 内部电脑开启 Tailscale Serve（第 2 步）

确认上一步 `internal-bridge` 已经在 `127.0.0.1:18787` 运行后，在内部电脑执行：

```bash
tailscale serve --bg --https=443 http://127.0.0.1:18787
```

含义：

- `serve`：把本机服务分享给同一个 tailnet 内的设备。
- `--bg`：后台持久运行。官方 CLI 文档说明带 `--bg` 时，设备重启或 Tailscale 重启后会自动恢复分享。
- `--https=443`：使用 Tailscale 提供的 HTTPS 地址。
- `http://127.0.0.1:18787`：实际被分享的本机 internal-bridge 地址。

查看 Serve 状态：

```bash
tailscale serve status
```

查看更完整配置：

```bash
tailscale serve get-config --all
```

关闭 Serve：

```bash
tailscale serve reset
```

`reset` 会清空这台电脑上的 Tailscale Serve 配置。如果你以后还用 Serve 分享别的服务，执行前要先确认不会误删其他 Serve 配置。

## 外部电脑验证内部服务

外部电脑不需要运行 `tailscale serve`。它只需要访问内部电脑的 Tailscale HTTPS 地址。

地址通常长这样：

```text
https://内部电脑名称.tailnet名称.ts.net/healthz
```

你可以从 Tailscale 管理后台 Machines 页面看到设备名称，也可以在内部电脑上运行：

```bash
tailscale status
```

外部电脑验证：

```bash
curl https://内部电脑名称.tailnet名称.ts.net/healthz
```

成功后，把外部电脑 `.env` 里的 `REMOTE_BASE_URL` 写成：

```bash
REMOTE_BASE_URL=https://内部电脑名称.tailnet名称.ts.net/openai
```

然后外部电脑启动：

```bash
npm run external:start
```

再验证外部本机接口：

```bash
curl.exe http://127.0.0.1:18788/healthz
curl.exe http://127.0.0.1:18788/openai/models
```

## 常见错误

### tailscale: command not found

说明 Tailscale 客户端可能没安装，或者 CLI 没进 PATH。

macOS 可以试：

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale status
```

Windows 可以试：

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" status
```

### 外部电脑访问 healthz 失败

先分层排查：

1. 内部电脑本机是否能访问：

   ```bash
   curl.exe http://127.0.0.1:18787/healthz
   ```

2. 内部电脑 `tailscale serve status` 是否有配置。
3. 两台电脑 `tailscale status` 是否都在线。
4. 外部电脑访问的地址是否是内部电脑的 Tailscale 域名，不是公司 CRS 域名。

### 不小心配置错了 Serve

可以重置：

```bash
tailscale serve reset
```

然后重新执行：

```bash
tailscale serve --bg --https=443 http://127.0.0.1:18787
```

### 担心它暴露到公网

`tailscale serve` 分享给 tailnet 内设备，不是公开互联网。公开互联网暴露对应的是 Tailscale Funnel，这个项目不使用 Funnel。
