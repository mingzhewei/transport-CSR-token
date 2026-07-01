# stop-external.ps1
# 外部电脑（Windows）停止 external-client。
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows\stop-external.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
Set-Location $RepoRoot

$pidFile = Join-Path $RepoRoot "run\external-client.pid"

if (Test-Path $pidFile) {
    $procId = Get-Content $pidFile | Select-Object -First 1
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "[stop-external] 已停止 external-client（PID: $procId）。" -ForegroundColor Green
    } catch {
        Write-Host "[stop-external] PID $procId 已不在运行。" -ForegroundColor Yellow
    }
    Remove-Item $pidFile -Force
} else {
    Write-Host "[stop-external] 未找到 PID 文件，尝试按端口查找 ..." -ForegroundColor Yellow
    $conn = Get-NetTCPConnection -LocalPort 18788 -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        Stop-Process -Id $conn.OwningProcess -Force
        Write-Host "[stop-external] 已停止占用 18788 的进程（PID: $($conn.OwningProcess)）。" -ForegroundColor Green
    } else {
        Write-Host "[stop-external] 没有进程在监听 18788。" -ForegroundColor Yellow
    }
}
