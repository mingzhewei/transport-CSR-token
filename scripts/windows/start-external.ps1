# start-external.ps1
# 外部电脑（Windows）一键启动 external-client，并做一次链路自检。
# 用法（在项目根目录）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-external.ps1

param(
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
Set-Location $RepoRoot

Write-Host "[start-external] 项目根目录: $RepoRoot" -ForegroundColor Cyan

# 1. 检查 .env
if (-not (Test-Path ".env")) {
    Write-Host "[start-external] 找不到 .env，请先复制 .env.example 为 .env 并填写 REMOTE_BASE_URL / BRIDGE_TOKEN。" -ForegroundColor Red
    exit 1
}

# 2. 解析端口（优先参数，其次 .env EXTERNAL_LISTEN_ADDR，最后 18788）
if ($Port -eq 0) {
    $addrLine = Select-String -Path ".env" -Pattern "^\s*EXTERNAL_LISTEN_ADDR\s*=" | Select-Object -First 1
    if ($addrLine) {
        $addr = ($addrLine.Line -split "=", 2)[1].Trim()
        $Port = [int]($addr -split ":")[-1]
    } else {
        $Port = 18788
    }
}
$HealthUrl = "http://127.0.0.1:$Port/healthz"
Write-Host "[start-external] external-client 端口: $Port" -ForegroundColor Cyan

# 3. 端口占用检查
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
    Write-Host "[start-external] 端口 $Port 已被占用（PID: $($inUse.OwningProcess -join ', ')）。" -ForegroundColor Yellow
    Write-Host "[start-external] 如需停止，运行 .\scripts\windows\stop-external.ps1" -ForegroundColor Yellow
    exit 1
}

# 4. 后台启动 external-client
Write-Host "[start-external] 启动 external-client ..." -ForegroundColor Cyan
$runDir = Join-Path $RepoRoot "run"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$proc = Start-Process -FilePath "node" `
    -ArgumentList "external-client/server.mjs" `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -PassThru
$proc.Id | Out-File -FilePath (Join-Path $runDir "external-client.pid") -Encoding ascii
Write-Host "[start-external] external-client 已启动，PID: $($proc.Id)" -ForegroundColor Green

# 5. 健康检查
Write-Host "[start-external] 等待 external-client 就绪 ..." -ForegroundColor Cyan
$ready = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        if ($resp.ok) { $ready = $true; break }
    } catch { }
}
if (-not $ready) {
    Write-Host "[start-external] external-client 在 15 秒内未通过健康检查。" -ForegroundColor Red
    exit 1
}
Write-Host "[start-external] external-client 健康检查通过: $HealthUrl" -ForegroundColor Green

# 6. 链路自检：调用 /debug/probe（需要 EXTERNAL_API_KEY 时带上）
$keyLine = Select-String -Path ".env" -Pattern "^\s*EXTERNAL_API_KEY\s*=" | Select-Object -First 1
$headers = @{}
if ($keyLine) {
    $key = ($keyLine.Line -split "=", 2)[1].Trim()
    if ($key) { $headers = @{ Authorization = "Bearer $key" } }
}

Write-Host "[start-external] 执行链路自检 /debug/probe ..." -ForegroundColor Cyan
try {
    $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/debug/probe" -Headers $headers -TimeoutSec 20
    if ($probe.ok) {
        Write-Host "[start-external] 链路自检通过：external-client -> internal-bridge 全部可达。" -ForegroundColor Green
    } else {
        Write-Host "[start-external] 链路自检发现问题，逐跳结果如下：" -ForegroundColor Yellow
        $probe.steps | ForEach-Object {
            $color = if ($_.ok) { "Green" } else { "Red" }
            Write-Host ("  {0} => ok={1} status={2}" -f $_.step, $_.ok, $_.status) -ForegroundColor $color
        }
        Write-Host "[start-external] 请检查 REMOTE_BASE_URL / BRIDGE_TOKEN，以及内部电脑是否已启动。" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[start-external] 链路自检请求失败：$($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "[start-external] 完成。将客户端 base_url 指向 http://127.0.0.1:$Port/openai 即可。" -ForegroundColor Green
