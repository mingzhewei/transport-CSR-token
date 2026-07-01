# start-internal.ps1
# 内部电脑（Windows）一键启动：先启动 internal-bridge，验证健康，再开启 tailscale serve。
# 用法（在项目根目录）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-internal.ps1
#
# 可选参数：
#   -NoServe     只启动 internal-bridge，不运行 tailscale serve
#   -Port 18787  覆盖端口（默认读取 .env 的 INTERNAL_LISTEN_ADDR，回退 18787）

param(
    [switch]$NoServe,
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"

# 定位项目根目录（脚本在 scripts/windows/ 下，向上两级）
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
Set-Location $RepoRoot

Write-Host "[start-internal] 项目根目录: $RepoRoot" -ForegroundColor Cyan

# 1. 检查 .env
if (-not (Test-Path ".env")) {
    Write-Host "[start-internal] 找不到 .env，请先复制 .env.example 为 .env 并填写配置。" -ForegroundColor Red
    exit 1
}

# 2. 解析端口（优先命令行参数，其次 .env，最后默认 18787）
if ($Port -eq 0) {
    $addrLine = Select-String -Path ".env" -Pattern "^\s*INTERNAL_LISTEN_ADDR\s*=" | Select-Object -First 1
    if ($addrLine) {
        $addr = ($addrLine.Line -split "=", 2)[1].Trim()
        $Port = [int]($addr -split ":")[-1]
    } else {
        $Port = 18787
    }
}
$HealthUrl = "http://127.0.0.1:$Port/healthz"
Write-Host "[start-internal] internal-bridge 端口: $Port" -ForegroundColor Cyan

# 3. 若端口已被占用，提示并退出
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
    Write-Host "[start-internal] 端口 $Port 已被占用（PID: $($inUse.OwningProcess -join ', ')）。" -ForegroundColor Yellow
    Write-Host "[start-internal] 如需停止，运行 .\scripts\windows\stop-internal.ps1" -ForegroundColor Yellow
    exit 1
}

# 4. 后台启动 internal-bridge
Write-Host "[start-internal] 启动 internal-bridge ..." -ForegroundColor Cyan
$runDir = Join-Path $RepoRoot "run"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$proc = Start-Process -FilePath "node" `
    -ArgumentList "internal-bridge/server.mjs" `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -PassThru
$proc.Id | Out-File -FilePath (Join-Path $runDir "internal-bridge.pid") -Encoding ascii
Write-Host "[start-internal] internal-bridge 已启动，PID: $($proc.Id)" -ForegroundColor Green

# 5. 轮询健康检查（最多等 15 秒）
Write-Host "[start-internal] 等待 internal-bridge 就绪 ..." -ForegroundColor Cyan
$ready = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        if ($resp.ok) { $ready = $true; break }
    } catch {
        # 还没起来，继续等
    }
}

if (-not $ready) {
    Write-Host "[start-internal] internal-bridge 在 15 秒内未通过健康检查，请检查日志或 .env 配置。" -ForegroundColor Red
    exit 1
}
Write-Host "[start-internal] internal-bridge 健康检查通过: $HealthUrl" -ForegroundColor Green

# 6. 启动 tailscale serve（除非 -NoServe）
if ($NoServe) {
    Write-Host "[start-internal] 已跳过 tailscale serve（-NoServe）。" -ForegroundColor Yellow
    exit 0
}

Write-Host "[start-internal] 配置 tailscale serve ..." -ForegroundColor Cyan
$tailscale = "tailscale"
if (-not (Get-Command $tailscale -ErrorAction SilentlyContinue)) {
    $fallback = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
    if (Test-Path $fallback) {
        $tailscale = $fallback
    } else {
        Write-Host "[start-internal] 找不到 tailscale 命令。internal-bridge 已在运行，请手动安装/登录 Tailscale 后执行：" -ForegroundColor Yellow
        Write-Host "  tailscale serve --bg --https=443 http://127.0.0.1:$Port" -ForegroundColor Yellow
        exit 0
    }
}

& $tailscale serve --bg --https=443 "http://127.0.0.1:$Port"
Write-Host "[start-internal] tailscale serve 已配置。查看状态：" -ForegroundColor Green
& $tailscale serve status

Write-Host ""
Write-Host "[start-internal] 完成。内部电脑已就绪，外部电脑现在可以通过 Tailscale 地址访问。" -ForegroundColor Green
