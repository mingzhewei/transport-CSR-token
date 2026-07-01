# 一键启动脚本

为两台电脑准备了启动/停止脚本，免去手动敲多条命令。脚本会自动定位项目根目录、读取 `.env` 中的端口、做健康检查。

## 脚本位置

```text
scripts/
  windows/
    start-internal.ps1   内部电脑：启动 internal-bridge + tailscale serve
    stop-internal.ps1    内部电脑：停止 internal-bridge（可选重置 serve）
    start-external.ps1   外部电脑（Windows）：启动 external-client + 链路自检
    stop-external.ps1    外部电脑（Windows）：停止 external-client
  macos/
    start-external.sh    外部电脑（macOS）：启动 external-client + 链路自检
    stop-external.sh     外部电脑（macOS）：停止 external-client
```

内部电脑目前是 Windows，所以内部启动脚本只提供 PowerShell 版。外部电脑可能是 Windows 或 macOS，两种都提供。

## 内部电脑（Windows）

在项目根目录打开 PowerShell：

```powershell
# 启动：先起 internal-bridge，健康检查通过后再开 tailscale serve
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-internal.ps1

# 只启动 internal-bridge，不动 tailscale serve
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-internal.ps1 -NoServe

# 停止 internal-bridge（保留 serve 配置）
powershell -ExecutionPolicy Bypass -File .\scripts\windows\stop-internal.ps1

# 停止并重置 tailscale serve（会清空本机所有 serve 配置，谨慎）
powershell -ExecutionPolicy Bypass -File .\scripts\windows\stop-internal.ps1 -ResetServe
```

启动脚本做的事：

1. 检查 `.env` 是否存在。
2. 从 `.env` 的 `INTERNAL_LISTEN_ADDR` 读端口（默认 18787）。
3. 检查端口是否被占用。
4. 后台启动 `internal-bridge`，把 PID 写入 `run/internal-bridge.pid`。
5. 轮询 `/healthz`，最多等 15 秒。
6. 健康检查通过后运行 `tailscale serve --bg --https=443 http://127.0.0.1:<端口>`。

## 外部电脑（Windows）

```powershell
# 启动 external-client，并自动跑一次 /debug/probe 链路自检
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-external.ps1

# 停止
powershell -ExecutionPolicy Bypass -File .\scripts\windows\stop-external.ps1
```

## 外部电脑（macOS）

首次使用给脚本加执行权限（只需一次）：

```bash
chmod +x scripts/macos/*.sh
```

然后：

```bash
# 启动 external-client，并自动跑一次 /debug/probe 链路自检
bash scripts/macos/start-external.sh

# 停止
bash scripts/macos/stop-external.sh
```

启动脚本会读取 `.env` 的 `EXTERNAL_API_KEY`，带上正确的鉴权头做链路自检。日志输出在 `logs/external-client.out`。

## 关于 PowerShell 执行策略

Windows 默认可能禁止运行脚本。上面命令用 `-ExecutionPolicy Bypass` 只对本次调用放行，不改变系统全局策略，是安全的做法。

如果希望长期允许当前用户运行本地脚本，可以（可选）执行一次：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 正式常驻运行

这些脚本用于日常手动启停。若要开机自启、崩溃自动重启，参考更正式的方案：

- Windows：PM2（`pm2 start ... && pm2 save && pm2 startup`）或 NSSM 注册为 Windows 服务。
- macOS：`launchd` plist 或 PM2。

需要时可以再补充对应的常驻配置。
