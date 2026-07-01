# stop-internal.ps1
# 内部电脑（Windows）停止：关闭 internal-bridge，并可选重置 tailscale serve。
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows\stop-internal.ps1
#
# 可选参数：
#   -ResetServe   同时执行 tailscale serve reset（会清空本机所有 serve 配置，谨慎使用）

param(
    [switch]$ResetServe
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
Set-Location $RepoRoot

$pidFile = Join-Path $RepoRoot "run\internal-bridge.pid"

# 1. 通过 PID 文件停止
if (Test-Path $pidFile) {
    $procId = Get-Content $pidFile | Select-Object -First 1
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "[stop-internal] 已停止 internal-bridge（PID: $procId）。" -ForegroundColor Green
    } catch {
        Write-Host "[stop-internal] PID $procId 已不在运行。" -ForegroundColor Yellow
    }
    Remove-Item $pidFile -Force
} else {
    Write-Host "[stop-internal] 未找到 PID 文件，尝试按端口查找 ..." -ForegroundColor Yellow
    $conn = Get-NetTCPConnection -LocalPort 18787 -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        Stop-Process -Id $conn.OwningProcess -Force
        Write-Host "[stop-internal] 已停止占用 18787 的进程（PID: $($conn.OwningProcess)）。" -ForegroundColor Green
    } else {
        Write-Host "[stop-internal] 没有进程在监听 18787。" -ForegroundColor Yellow
    }
}

# 2. 可选重置 tailscale serve
if ($ResetServe) {
    Write-Host "[stop-internal] 重置 tailscale serve ..." -ForegroundColor Cyan
    $tailscale = "tailscale"
    if (-not (Get-Command $tailscale -ErrorAction SilentlyContinue)) {
        $fallback = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
        if (Test-Path $fallback) { $tailscale = $fallback }
    }
    try {
        & $tailscale serve reset
        Write-Host "[stop-internal] tailscale serve 已重置。" -ForegroundColor Green
    } catch {
        Write-Host "[stop-internal] 重置 tailscale serve 失败（可能未安装或未运行）。" -ForegroundColor Yellow
    }
} else {
    Write-Host "[stop-internal] 保留 tailscale serve 配置。如需清除，加 -ResetServe 参数。" -ForegroundColor Cyan
}
