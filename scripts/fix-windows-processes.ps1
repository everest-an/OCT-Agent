# OCT Agent Windows 进程修复脚本
# 自动修复 Gateway 和 Daemon 启动问题
#
# 常见故障原因：
#   1. npm 缓存损坏 (ECOMPROMISED) — npm 在下载/安装过程中被中断（断网、强制关机）
#      导致 _npx 缓存目录内容不完整，下次 npx 启动 daemon 时报错并卡住
#   2. npx 缓存目录被文件锁住 (EPERM/EBUSY) — Windows 上 better-sqlite3.node
#      等 native addon 在进程退出后仍短暂持有文件句柄，导致 npm 无法清理旧缓存
#   3. Daemon 进程意外退出 — 系统休眠/唤醒、内存压力、或 Windows 更新重启
#      会杀掉后台 node 进程，而 watchdog 最多重试 5 次后会停止尝试
#   4. Gateway event loop 阻塞 — models.list 调用 Qwen API 耗时 17-200 秒，
#      阻塞 WS 握手，Desktop 10s 超时后走 CLI fallback，每轮聊天都很慢
#   5. 双实例冲突 — 两个 gateway 进程同时监听 18789，互相竞争导致 CPU 打满
#
# 用户遇到以下症状时运行此脚本：
#   - 聊天时显示 "Gateway is still warming up" / "local fallback mode"
#   - 每轮聊天都很慢（>15 秒才有回复）
#   - "Preparing local memory service..." 一直转圈
#   - "Local memory service is still starting" 错误

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
    $daemonPid = $daemonProcess.OwningProcess
    
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
            Stop-Process -Id $daemonPid -Force -ErrorAction Stop
            Start-Sleep -Seconds 2
            Write-Host "  ✅ 已终止旧进程" -ForegroundColor Green
        } catch {
            Write-Host "  ❌ 无法终止进程: $_" -ForegroundColor Red
        }
    }
} else {
    Write-Host "  [INFO] Daemon is not running" -ForegroundColor Gray
}

# 4. 清理 npx 缓存（包括损坏和锁住的条目）
Write-Host ""
Write-Host "[4/5] 清理 npx 缓存..." -ForegroundColor Yellow

# 先检查 npm 缓存是否损坏
$cacheVerify = & npm cache verify 2>&1 | Select-String -Pattern "ECOMPROMISED|corrupted|error" -SimpleMatch
if ($cacheVerify) {
    Write-Host "  ⚠️  检测到 npm 缓存损坏，正在强制清理..." -ForegroundColor Yellow
    & npm cache clean --force 2>&1 | Out-Null
    Write-Host "  ✅ npm 缓存已清理" -ForegroundColor Green
}

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
                $huggingfacePath = Join-Path $entry.FullName "node_modules\@huggingface"
                if ((Test-Path $sdkPath) -or (Test-Path $huggingfacePath)) {
                    # 先尝试普通删除
                    try {
                        Remove-Item $entry.FullName -Recurse -Force -ErrorAction Stop
                        $cleaned++
                    } catch {
                        # EPERM/EBUSY: 文件被锁住，用 cmd rd /s /q 强制删除
                        Write-Host "  ⚠️  目录被锁住，尝试强制删除: $($entry.Name)" -ForegroundColor Yellow
                        $result = cmd /c "rd /s /q `"$($entry.FullName)`"" 2>&1
                        if (-not (Test-Path $entry.FullName)) {
                            $cleaned++
                            Write-Host "  ✅ 强制删除成功" -ForegroundColor Green
                        } else {
                            Write-Host "  ❌ 无法删除（可能需要重启后再试）: $($entry.FullName)" -ForegroundColor Red
                        }
                    }
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
    Write-Host "  ✅ 缓存正常，无需清理" -ForegroundColor Green
}

# 5. 启动服务
Write-Host ""
Write-Host "[5/5] 启动服务..." -ForegroundColor Yellow

# 检查并修复 Gateway 双实例冲突
$gatewayPort = 18789
$gatewayConns = Get-NetTCPConnection -LocalPort $gatewayPort -State Listen -ErrorAction SilentlyContinue
$gatewayPids = $gatewayConns | Select-Object -ExpandProperty OwningProcess -Unique

if ($gatewayPids.Count -gt 1) {
    Write-Host "  ⚠️  检测到 Gateway 双实例冲突 ($($gatewayPids.Count) 个进程监听同一端口)，清理旧实例..." -ForegroundColor Yellow
    # 保留最新的进程（启动时间最晚），杀掉其余的
    $procs = $gatewayPids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Sort-Object StartTime -Descending
    $procs | Select-Object -Skip 1 | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  ✅ 已终止旧 Gateway 实例 PID $($_.Id)" -ForegroundColor Green
    }
    Start-Sleep -Seconds 2
}

# 启动 Gateway
$gatewayRunning = Get-NetTCPConnection -LocalPort $gatewayPort -State Listen -ErrorAction SilentlyContinue

if (-not $gatewayRunning -or $Force) {
    Write-Host "  正在启动 Gateway..." -ForegroundColor Yellow
    try {
        if ($isAdmin) {
            $output = & openclaw gateway start 2>&1
            Write-Host "  ✅ Gateway 启动命令已执行" -ForegroundColor Green
        } else {
            Write-Host "  [INFO] 非管理员模式：在当前会话启动 Gateway..." -ForegroundColor Gray
            Start-Process -WindowStyle Hidden -FilePath "openclaw" -ArgumentList "gateway","run","--force","--allow-unconfigured" -ErrorAction Stop
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
$daemonPort = 37800
$daemonRunning = Get-NetTCPConnection -LocalPort $daemonPort -State Listen -ErrorAction SilentlyContinue

if (-not $daemonRunning -or $Force) {
    Write-Host "  正在启动 Daemon..." -ForegroundColor Yellow
    try {
        $projectDir = $OPENCLAW_DIR
        $startCmd = "npx -y @awareness-sdk/local@latest start --port $daemonPort --project `"$projectDir`" --background"
        
        Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/d","/c",$startCmd -ErrorAction Stop
        Write-Host "  ✅ Daemon 启动命令已执行，等待就绪..." -ForegroundColor Green
        
        # 等待 daemon 就绪（最多 60 秒）
        $waited = 0
        $ready = $false
        while ($waited -lt 60) {
            Start-Sleep -Seconds 3
            $waited += 3
            try {
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:$daemonPort/healthz" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
                if ($response.StatusCode -eq 200) {
                    $ready = $true
                    break
                }
            } catch { }
            Write-Host "  ... 等待中 ($waited s)" -ForegroundColor Gray
        }
        
        if ($ready) {
            Write-Host "  ✅ Daemon 已就绪" -ForegroundColor Green
        } else {
            Write-Host "  ⚠️  Daemon 启动超时，可能仍在下载依赖，请稍后再试" -ForegroundColor Yellow
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
Write-Host "请重新打开 OCT Agent 并测试聊天功能。" -ForegroundColor Yellow
Write-Host ""
Write-Host "如果问题仍然存在：" -ForegroundColor Yellow
Write-Host "  1. 以管理员身份重新运行此脚本" -ForegroundColor White
Write-Host "  2. 使用 -Force 强制重启所有服务" -ForegroundColor White
Write-Host "  3. 使用 -KillZombies 清理残留进程" -ForegroundColor White
Write-Host "  4. 在应用内：Settings → Health → Run Doctor" -ForegroundColor White
Write-Host ""
