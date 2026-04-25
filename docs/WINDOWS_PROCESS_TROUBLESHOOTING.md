# Windows 进程启动问题排查指南

## 问题现象

安装 AwarenessClaw 后，可能出现以下问题：
- ❌ 聊天功能无响应
- ❌ 记忆功能无法加载
- ❌ 应用显示 "Connecting to local Gateway..."
- ❌ 设置页面显示服务未运行

## 根本原因

AwarenessClaw 依赖两个后台服务：

1. **OpenClaw Gateway** (端口 18789)
   - 处理 AI 聊天、工具调用
   - 通过 Windows 计划任务或启动脚本运行

2. **Awareness Local Daemon** (端口 37800)
   - 本地知识库和记忆存储
   - 通过 npx 启动

Windows 环境下常见启动失败原因：
- 启动脚本丢失
- 权限不足
- 端口被僵尸进程占用
- npx 缓存损坏
- PATH 环境变量缺失

---

## 快速诊断

### 方法 1：使用诊断脚本（推荐）

在项目根目录打开 PowerShell：

```powershell
# 运行诊断
.\scripts\diagnose-windows-processes.ps1
```

脚本会检查：
- ✅ Gateway 是否运行
- ✅ Daemon 是否运行
- ✅ 启动配置是否正确
- ✅ 是否有僵尸进程
- ✅ OpenClaw CLI 和 npx 是否可用

### 方法 2：手动检查

#### 检查 Gateway

```powershell
# 检查端口 18789 是否被占用
Get-NetTCPConnection -LocalPort 18789 -ErrorAction SilentlyContinue

# 检查 Gateway 进程
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -match 'gateway.*run'
}
```

#### 检查 Daemon

```powershell
# 检查端口 37800 是否被占用
Get-NetTCPConnection -LocalPort 37800 -ErrorAction SilentlyContinue

# 测试健康检查
Invoke-WebRequest -Uri "http://127.0.0.1:37800/healthz" -UseBasicParsing
```

---

## 自动修复

### 方法 1：使用修复脚本（推荐）

```powershell
# 基础修复
.\scripts\fix-windows-processes.ps1

# 强制重启所有服务
.\scripts\fix-windows-processes.ps1 -Force

# 清理僵尸进程
.\scripts\fix-windows-processes.ps1 -KillZombies

# 完整修复（需要管理员权限）
.\scripts\fix-windows-processes.ps1 -Force -KillZombies
```

**以管理员身份运行：**
```powershell
# 右键 PowerShell → 以管理员身份运行
Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File .\scripts\fix-windows-processes.ps1 -Force -KillZombies"
```

### 方法 2：应用内修复

1. 打开 AwarenessClaw
2. 进入 **Settings** → **Health**
3. 点击 **Run Doctor**
4. 点击 **Fix All**

---

## 手动修复

### 修复 Gateway

#### 问题：Gateway 未运行

```powershell
# 检查 OpenClaw CLI 是否安装
openclaw --version

# 如果未安装，先安装
npm install -g openclaw

# 启动 Gateway
openclaw gateway start
```

#### 问题：启动脚本丢失

```powershell
# 重新安装 Gateway
openclaw gateway install

# 修复 stack-size 参数（防止 AJV 栈溢出）
$gatewayCmdPath = "$env:USERPROFILE\.openclaw\gateway.cmd"
$content = Get-Content $gatewayCmdPath -Raw
$content = $content -replace '(node\.exe"?\s+)', '$1--stack-size=8192 '
Set-Content -Path $gatewayCmdPath -Value $content -NoNewline
```

#### 问题：权限不足（非管理员）

```powershell
# 在当前会话启动 Gateway（不需要管理员权限）
Start-Process -WindowStyle Hidden -FilePath "openclaw" `
  -ArgumentList "gateway","run","--force","--allow-unconfigured"
```

### 修复 Daemon

#### 问题：Daemon 未运行

```powershell
# 检查 npx 是否可用
npx --version

# 如果未安装，先安装 Node.js
# 下载：https://nodejs.org/

# 启动 Daemon
$projectDir = "$env:USERPROFILE\.openclaw"
npx -y @awareness-sdk/local@latest start --port 37800 --project "$projectDir" --background
```

#### 问题：端口被僵尸进程占用

```powershell
# 查找占用端口的进程
$conn = Get-NetTCPConnection -LocalPort 37800 -ErrorAction SilentlyContinue
$pid = $conn.OwningProcess

# 终止进程
Stop-Process -Id $pid -Force

# 重新启动 Daemon
npx -y @awareness-sdk/local@latest start --port 37800 --project "$env:USERPROFILE\.openclaw" --background
```

#### 问题：npx 缓存损坏

```powershell
# 清理 npx 缓存
$npxCache = "$env:USERPROFILE\.npm\_npx"
if (Test-Path $npxCache) {
    Get-ChildItem $npxCache -Directory | Where-Object {
        Test-Path (Join-Path $_.FullName "node_modules\@awareness-sdk")
    } | Remove-Item -Recurse -Force
}

# 清理 LOCALAPPDATA 缓存
$localCache = "$env:LOCALAPPDATA\npm-cache\_npx"
if (Test-Path $localCache) {
    Get-ChildItem $localCache -Directory | Where-Object {
        Test-Path (Join-Path $_.FullName "node_modules\@awareness-sdk")
    } | Remove-Item -Recurse -Force
}

# 重新启动 Daemon
npx -y @awareness-sdk/local@latest start --port 37800 --project "$env:USERPROFILE\.openclaw" --background
```

### 清理僵尸进程

```powershell
# 查找所有 OpenClaw 相关进程
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'openclaw' -or $_.CommandLine -match 'awareness-sdk'
} | ForEach-Object {
    Write-Host "PID: $($_.ProcessId), 命令: $($_.CommandLine)"
}

# 终止特定进程
Stop-Process -Id <PID> -Force

# 批量清理频道登录僵尸进程
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'openclaw.*channels.*login'
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
}
```

---

## 预防措施

### 1. 确保环境变量正确

```powershell
# 检查 PATH
$env:PATH -split ';' | Select-String -Pattern 'node|npm'

# 如果缺失，添加 Node.js 到 PATH
# 系统属性 → 高级 → 环境变量 → Path → 添加：
# C:\Program Files\nodejs\
```

### 2. 定期清理僵尸进程

在 Windows 任务计划程序中创建定时任务：

```powershell
# 创建清理脚本
$cleanupScript = @"
Get-CimInstance Win32_Process | Where-Object {
    `$_.CommandLine -match 'openclaw.*channels.*login'
} | ForEach-Object {
    Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue
}
"@

$cleanupScript | Out-File "$env:USERPROFILE\.openclaw\cleanup-zombies.ps1"

# 创建计划任务（每天凌晨 3 点运行）
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-ExecutionPolicy Bypass -File `"$env:USERPROFILE\.openclaw\cleanup-zombies.ps1`""
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
Register-ScheduledTask -TaskName "AwarenessClaw Cleanup" -Action $action -Trigger $trigger
```

### 3. 应用退出时清理

AwarenessClaw 应用会在退出时自动清理子进程，但如果强制关闭（任务管理器），可能留下僵尸进程。

建议：
- 使用应用内的退出按钮
- 避免从任务管理器强制结束

---

## 常见错误信息

### "Gateway returned an empty reply"

**原因**：Gateway 未运行或崩溃

**解决**：
```powershell
.\scripts\fix-windows-processes.ps1 -Force
```

### "Local service is taking longer than expected"

**原因**：Daemon 启动失败或 npx 缓存损坏

**解决**：
```powershell
# 清理缓存并重启
.\scripts\fix-windows-processes.ps1 -Force
```

### "OpenClaw could not start the local helper runtime"

**原因**：
1. Gateway 插件缺少 spawn 错误处理（会导致 Gateway 崩溃）
2. npx 不在 PATH 中

**解决**：
```powershell
# 方法 1：应用内修复
# Settings → Health → Run Doctor → Fix All

# 方法 2：手动修复插件
$pluginPath = "$env:USERPROFILE\.openclaw\extensions\openclaw-memory\dist\index.js"
$content = Get-Content $pluginPath -Raw
$content = $content -replace '(\bchild\.unref\s*\(\s*\)\s*;)', 'child.on("error", () => {}); $1'
Set-Content -Path $pluginPath -Value $content
```

### "schtasks run failed" 或 "Access is denied"

**原因**：没有管理员权限安装 Windows 计划任务

**解决**：
```powershell
# 方法 1：以管理员身份运行修复脚本
Start-Process powershell -Verb RunAs -ArgumentList `
  "-ExecutionPolicy Bypass -File .\scripts\fix-windows-processes.ps1 -Force"

# 方法 2：在当前会话运行（不需要管理员）
Start-Process -WindowStyle Hidden -FilePath "openclaw" `
  -ArgumentList "gateway","run","--force","--allow-unconfigured"
```

---

## 获取帮助

如果以上方法都无法解决问题：

1. **收集诊断信息**：
   ```powershell
   .\scripts\diagnose-windows-processes.ps1 > diagnosis.txt
   ```

2. **查看日志**：
   - Gateway 日志：`%USERPROFILE%\.openclaw\logs\gateway.log`
   - Daemon 日志：`%USERPROFILE%\.openclaw\.awareness\daemon.log`
   - 应用日志：Settings → Health → View Logs

3. **提交 Issue**：
   - 附上 `diagnosis.txt`
   - 附上相关日志文件
   - 描述具体的错误信息和操作步骤

---

## 技术细节

### Gateway 启动流程

1. **计划任务方式**（需要管理员权限）：
   ```
   openclaw gateway install
   → 创建 Windows 计划任务
   → 创建 %USERPROFILE%\.openclaw\gateway.cmd
   → 创建启动项快捷方式
   ```

2. **当前会话方式**（不需要管理员权限）：
   ```
   openclaw gateway run --force --allow-unconfigured
   → 直接在当前 PowerShell 会话运行
   → 应用关闭后 Gateway 也会停止
   ```

### Daemon 启动流程

```
npx @awareness-sdk/local start --port 37800 --background
→ 下载/使用缓存的 @awareness-sdk/local
→ 启动 HTTP 服务器监听 37800
→ 初始化 SQLite 数据库
→ 后台运行（detached 模式）
```

### 进程依赖关系

```
AwarenessClaw.exe (主应用)
├── node.exe (OpenClaw Gateway)
│   └── 监听端口 18789
├── node.exe (Awareness Daemon)
│   └── 监听端口 37800
└── cmd.exe + node.exe (频道登录进程，可选)
    └── openclaw channels login
```

---

## 更新日志

- **2026-04-18**: 初始版本，添加诊断和修复脚本
- **2026-04-18**: 添加 Windows 特定的已知问题和解决方案
