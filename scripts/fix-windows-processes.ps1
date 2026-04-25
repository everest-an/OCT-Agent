# AwarenessClaw Windows 进程修复脚本
# 自动修复 Gateway 和 Daemon 启动问题

param(
    [switch]$Force,
    [switch]$KillZombies
)

Write-Host "=== AwarenessClaw Windows 进程修复 ===" -ForegroundColor Cyan
Write-Host ""

$HOME_DIR = $env:USERPROFILE
$OPENCLAW_DIR = Join-Path $HOME_DIR ".openclaw"

# 检查管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "⚠️  警告: 未以管理员身份运行，某些修复可能失败" -ForegroundColor Yellow
    Write-Host ""
}

# 1. 清理僵尸进程
if ($KillZombies) {
    Write-Host "[1/5] 清理僵尸进程..." -ForegroundColor Yellow
    
    $zombies = Get-CimInstance Win32_Process | Where-Object {
        ($_.CommandLine -match 'openclaw.*channels.*login') -or
        ($_.CommandLine -match 'awareness-sdk' -and $_.CommandLine -notmatch 'start')
    }
    
    if ($zombies) {
        Write-Host "  找到 $($zombies.Count) 个僵尸进程" -ForegroundColor Gray
        foreach ($zombie in $zombies) {
            try {
                Stop-Process -Id $zombie.ProcessId -Force -ErrorAction Stop
                Write-Host "  ✅ 已终止 PID: $($zombie.ProcessId)" -ForegroundColor Green
            } catch {
                Write-Host "  ❌ 无法终止 PID: $($zombie.ProcessId)" -ForegroundColor Red
            }
        }
    } else {
        Write-Host "  ✅ 未发现僵尸进程" -ForegroundColor Green
    }
} else {
    Write-Host "[1/5] 跳过僵尸进程清理 (使用 -KillZombies 启用)" -ForegroundColor Gray
}

# 2. 修复 Gateway 启动脚本
Write-Host ""
Write-Host "[2/5] 检查 Gateway 启动脚本..." -ForegroundColor Yellow

$startupCmdPath = Join-Path $HOME_DIR "AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\OpenClaw Gateway.cmd"
$gatewayCmdPath = Join-Path $OPENCLAW_DIR "gateway.cmd"

if ((Test-Path $startupCmdPath) -and (-not (Test-Path $gatewayCmdPath))) {
    Write-Host "  ❌ 检测到启动脚本丢失问题" -ForegroundColor Red
    Write-Host "  正在重新安装 Gateway..." -ForegroundColor Yellow
    
    try {
        $output = & openclaw gateway install 2>&1
        Write-Host "  ✅ Gateway 重新安装完成" -ForegroundColor Green
        
        # 修复 stack-size 问题
        if (Test-Path $gatewayCmdPath) {
            $content = Get-Content $gatewayCmdPath -Raw
            if ($content -notmatch '--stack-size') {
                $content = $content -replace '(node\.exe"?\s+)', '$1--stack-size=8192 '
                Set-Content -Path $gatewayCmdPath -Value $content -NoNewline
                Write-Host "  ✅ 已添加 --stack-size=8192 参数" -ForegroundColor Green
            }
        }
    } catch {
        Write-Host "  ❌ 重新安装失败: $_" -ForegroundColor Red
    }
} else {
    Write-Host "  ✅ 启动脚本正常" -ForegroundColor Green
}

# 3. 清理 Daemon 端口占用
Write-Host ""
Write-Host "[3/5] 检查 Daemon 端口占用..." -ForegroundColor Yellow

$daemonPort = 37800
$daemonProcess = Get-NetTCPConnection -LocalPort $daemonPort -ErrorAction SilentlyContinue

if ($daemonProcess) {
    $pid = $daemonProcess.OwningProcess
    
    # 测试健康检查
    $isHealthy = $false
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$daemonPort/healthz" -TimeoutSec 3 -UseBasicParsing
        $isHealthy = ($response.StatusCode -eq 200)
    } catch {
        $isHealthy = $false
    }
    
    if ($isHealthy) {
        Write-Host "  ✅ Daemon 运行正常" -ForegroundColor Green
    } else {
        Write-Host "  ⚠️  Daemon 端口被占用但不健康，正在重启..." -ForegroundColor Yellow
        
        try {
            Stop-Process -Id $pid -Force -ErrorAction Stop
            Start-Sleep -Seconds 2
            Write-Host "  ✅ 已终止旧进程" -ForegroundColor Green
        } catch {
            Write-Host "  ❌ 无法终止进程: $_" -ForegroundColor Red
        }
    }
} else {
    Write-Host "  ℹ️  Daemon 未运行" -ForegroundColor Gray
}

# 4. 清理 npx 缓存
Write-Host ""
Write-Host "[4/5] 清理 npx 缓存..." -ForegroundColor Yellow

$npxCacheDirs = @(
    (Join-Path $HOME_DIR ".npm\_npx"),
    (Join-Path $env:LOCALAPPDATA "npm-cache\_npx")
)

$cleaned = 0
foreach ($cacheDir in $npxCacheDirs) {
    if (Test-Path $cacheDir) {
        try {
            $entries = Get-ChildItem $cacheDir -Directory -ErrorAction SilentlyContinue
            foreach ($entry in $entries) {
                $sdkPath = Join-Path $entry.FullName "node_modules\@awareness-sdk"
                if (Test-Path $sdkPath) {
                    Remove-Item $entry.FullName -Recurse -Force -ErrorAction Stop
                    $cleaned++
                }
            }
        } catch {
            Write-Host "  ⚠️  清理 $cacheDir 时出错: $_" -ForegroundColor Yellow
        }
    }
}

if ($cleaned -gt 0) {
    Write-Host "  ✅ 已清理 $cleaned 个缓存条目" -ForegroundColor Green
} else {
    Write-Host "  ✅ 缓存干净" -ForegroundColor Green
}

# 5. 启动服务
Write-Host ""
Write-Host "[5/5] 启动服务..." -ForegroundColor Yellow

# 启动 Gateway
$gatewayPort = 18789
$gatewayRunning = Get-NetTCPConnection -LocalPort $gatewayPort -ErrorAction SilentlyContinue

if (-not $gatewayRunning -or $Force) {
    Write-Host "  正在启动 Gateway..." -ForegroundColor Yellow
    try {
        if ($isAdmin) {
            $output = & openclaw gateway start 2>&1
            Write-Host "  ✅ Gateway 启动命令已执行" -ForegroundColor Green
        } else {
            # 非管理员模式：在当前会话启动
            Write-Host "  ℹ️  非管理员模式，在当前会话启动 Gateway..." -ForegroundColor Gray
            Start-Process -WindowStyle Hidden -FilePath "openclaw" -ArgumentList "gateway","run","--force","--allow-unconfigured" -NoNewWindow
            Write-Host "  ✅ Gateway 已在当前会话启动" -ForegroundColor Green
        }
        Start-Sleep -Seconds 3
    } catch {
        Write-Host "  ❌ Gateway 启动失败: $_" -ForegroundColor Red
    }
} else {
    Write-Host "  ✅ Gateway 已在运行" -ForegroundColor Green
}

# 启动 Daemon
$daemonRunning = Get-NetTCPConnection -LocalPort $daemonPort -ErrorAction SilentlyContinue

if (-not $daemonRunning -or $Force) {
    Write-Host "  正在启动 Daemon..." -ForegroundColor Yellow
    try {
        $projectDir = $OPENCLAW_DIR
        $startCmd = "npx -y @awareness-sdk/local@latest start --port $daemonPort --project `"$projectDir`" --background"
        
        Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/d","/c",$startCmd -NoNewWindow
        Write-Host "  ✅ Daemon 启动命令已执行" -ForegroundColor Green
        Start-Sleep -Seconds 5
        
        # 验证
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$daemonPort/healthz" -TimeoutSec 3 -UseBasicParsing
            if ($response.StatusCode -eq 200) {
                Write-Host "  ✅ Daemon 启动成功" -ForegroundColor Green
            }
        } catch {
            Write-Host "  ⚠️  Daemon 可能需要更多时间启动" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  ❌ Daemon 启动失败: $_" -ForegroundColor Red
    }
} else {
    Write-Host "  ✅ Daemon 已在运行" -ForegroundColor Green
}

# 总结
Write-Host ""
Write-Host "=== 修复完成 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "请重新打开 AwarenessClaw 应用并测试功能" -ForegroundColor Yellow
Write-Host ""
Write-Host "如果问题仍然存在:" -ForegroundColor Yellow
Write-Host "  1. 以管理员身份运行此脚本" -ForegroundColor White
Write-Host "  2. 使用 -Force 参数强制重启所有服务" -ForegroundColor White
Write-Host "  3. 使用 -KillZombies 参数清理僵尸进程" -ForegroundColor White
Write-Host "  4. 在应用内打开 Settings → Health → Run Doctor" -ForegroundColor White
Write-Host ""
