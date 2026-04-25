# AwarenessClaw Windows 进程诊断脚本
# 检查 Gateway、Daemon 和其他关键进程的状态

Write-Host "=== AwarenessClaw Windows 进程诊断 ===" -ForegroundColor Cyan
Write-Host ""

$HOME_DIR = $env:USERPROFILE
$OPENCLAW_DIR = Join-Path $HOME_DIR ".openclaw"

# 1. 检查 OpenClaw Gateway
Write-Host "[1/6] 检查 OpenClaw Gateway..." -ForegroundColor Yellow

# 检查 Gateway 端口 (默认 18789)
$gatewayPort = 18789
$gatewayConfig = Join-Path $OPENCLAW_DIR "openclaw.json"
if (Test-Path $gatewayConfig) {
    try {
        $config = Get-Content $gatewayConfig -Raw | ConvertFrom-Json
        if ($config.gateway.port) {
            $gatewayPort = $config.gateway.port
        }
    } catch {
        Write-Host "  ⚠️  无法读取 openclaw.json" -ForegroundColor Yellow
    }
}

Write-Host "  检查端口: $gatewayPort"

# 检查端口是否被占用
$gatewayProcess = Get-NetTCPConnection -LocalPort $gatewayPort -ErrorAction SilentlyContinue
if ($gatewayProcess) {
    $processPid = $gatewayProcess.OwningProcess
    $process = Get-Process -Id $processPid -ErrorAction SilentlyContinue
    Write-Host "  ✅ Gateway 正在运行 (PID: $processPid, 进程: $($process.ProcessName))" -ForegroundColor Green
} else {
    Write-Host "  ❌ Gateway 未运行 (端口 $gatewayPort 未被占用)" -ForegroundColor Red
    
    # 检查是否有 node 进程运行 gateway
    $gatewayNodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -match 'gateway.*run'
    }
    if ($gatewayNodes) {
        Write-Host "  ⚠️  发现 Gateway 进程但未监听端口:" -ForegroundColor Yellow
        foreach ($proc in $gatewayNodes) {
            Write-Host "     PID: $($proc.ProcessId), 命令: $($proc.CommandLine)" -ForegroundColor Gray
        }
    }
}

# 检查 Windows 启动项
Write-Host ""
Write-Host "[2/6] 检查 Windows 启动配置..." -ForegroundColor Yellow

$startupCmdPath = Join-Path $HOME_DIR "AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\OpenClaw Gateway.cmd"
$gatewayCmdPath = Join-Path $OPENCLAW_DIR "gateway.cmd"

if (Test-Path $startupCmdPath) {
    Write-Host "  ✅ 启动项存在: $startupCmdPath" -ForegroundColor Green
    if (Test-Path $gatewayCmdPath) {
        Write-Host "  ✅ 启动脚本存在: $gatewayCmdPath" -ForegroundColor Green
    } else {
        Write-Host "  ❌ 启动脚本丢失: $gatewayCmdPath" -ForegroundColor Red
        Write-Host "     这会导致 Gateway 无法启动！" -ForegroundColor Red
    }
} else {
    Write-Host "  ⚠️  未找到启动项 (可能使用计划任务)" -ForegroundColor Yellow
}

# 检查计划任务
$scheduledTask = Get-ScheduledTask -TaskName "*OpenClaw*" -ErrorAction SilentlyContinue
if ($scheduledTask) {
    Write-Host "  ✅ 找到计划任务:" -ForegroundColor Green
    foreach ($task in $scheduledTask) {
        Write-Host "     名称: $($task.TaskName), 状态: $($task.State)" -ForegroundColor Gray
    }
} else {
    Write-Host "  ⚠️  未找到 OpenClaw 计划任务" -ForegroundColor Yellow
}

# 2. 检查 Awareness Local Daemon
Write-Host ""
Write-Host "[3/6] 检查 Awareness Local Daemon..." -ForegroundColor Yellow

$daemonPort = 37800
$daemonProcess = Get-NetTCPConnection -LocalPort $daemonPort -ErrorAction SilentlyContinue
if ($daemonProcess) {
    $pid = $daemonProcess.OwningProcess
    $process = Get-Process -Id $pid -ErrorAction SilentlyContinue
    Write-Host "  ✅ Daemon 正在运行 (PID: $pid, 进程: $($process.ProcessName))" -ForegroundColor Green
    
    # 测试健康检查
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$daemonPort/healthz" -TimeoutSec 3 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            Write-Host "  ✅ Daemon 健康检查通过" -ForegroundColor Green
        }
    } catch {
        Write-Host "  ⚠️  Daemon 端口被占用但健康检查失败" -ForegroundColor Yellow
    }
} else {
    Write-Host "  ❌ Daemon 未运行 (端口 $daemonPort 未被占用)" -ForegroundColor Red
}

# 3. 检查 OpenClaw CLI
Write-Host ""
Write-Host "[4/6] 检查 OpenClaw CLI..." -ForegroundColor Yellow

try {
    $openclawPath = (Get-Command openclaw -ErrorAction Stop).Source
    Write-Host "  ✅ OpenClaw CLI 已安装: $openclawPath" -ForegroundColor Green
    
    # 检查版本
    $version = & openclaw --version 2>&1
    Write-Host "  版本: $version" -ForegroundColor Gray
} catch {
    Write-Host "  ❌ OpenClaw CLI 未找到 (未在 PATH 中)" -ForegroundColor Red
}

# 4. 检查 npx
Write-Host ""
Write-Host "[5/6] 检查 npx..." -ForegroundColor Yellow

try {
    $npxPath = (Get-Command npx -ErrorAction Stop).Source
    Write-Host "  ✅ npx 已安装: $npxPath" -ForegroundColor Green
} catch {
    Write-Host "  ❌ npx 未找到 (Daemon 无法启动)" -ForegroundColor Red
}

# 5. 检查僵尸进程
Write-Host ""
Write-Host "[6/6] 检查僵尸进程..." -ForegroundColor Yellow

# 检查 openclaw 相关进程
$openclawProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'openclaw' -or $_.CommandLine -match 'awareness-sdk'
}

if ($openclawProcesses) {
    Write-Host "  找到 $($openclawProcesses.Count) 个相关进程:" -ForegroundColor Gray
    foreach ($proc in $openclawProcesses) {
        $process = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
        if ($process) {
            $memoryMB = [math]::Round($process.WorkingSet64 / 1MB, 2)
            Write-Host "     PID: $($proc.ProcessId), 内存: ${memoryMB}MB, 进程: $($process.ProcessName)" -ForegroundColor Gray
            Write-Host "     命令: $($proc.CommandLine)" -ForegroundColor DarkGray
        }
    }
} else {
    Write-Host "  未找到相关进程" -ForegroundColor Gray
}

# 总结
Write-Host ""
Write-Host "=== 诊断完成 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "建议操作:" -ForegroundColor Yellow
Write-Host "  1. 如果 Gateway 未运行，在应用内打开 Settings → Health → Fix All" -ForegroundColor White
Write-Host "  2. 如果 Daemon 未运行，应用会自动尝试启动" -ForegroundColor White
Write-Host "  3. 如果发现启动脚本丢失，运行: openclaw gateway install" -ForegroundColor White
Write-Host "  4. 如果有僵尸进程占用大量内存，可以手动结束" -ForegroundColor White
Write-Host ""
}
