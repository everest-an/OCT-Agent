# OpenClaw 模块丢失错误修复指南

## 问题描述

如果您看到类似以下的错误信息：

```
15:36:22 [gateway] request handler failed: Error: Cannot find module 
'C:\Users\admin\AppData\Roaming\npm\node_modules\openclaw\dist\server-methods-DSL6KpJ1.js' 
imported from C:\Users\admin\AppData\Roaming\npm\node_modules\openclaw\dist\server.impl-D5mN3W3v.js
code=ERR_MODULE_NOT_FOUND
```

这表示 OpenClaw 的安装文件损坏或版本不匹配。

## 原因分析

这个错误通常发生在以下情况：

1. **OpenClaw 更新不完整**：npm 更新过程中断或失败
2. **文件哈希不匹配**：构建产物的哈希文件名与引用不一致
3. **缓存问题**：npm 全局缓存损坏
4. **进程残留**：旧版本的 Gateway 进程仍在运行

## 快速修复（推荐）

### 方法一：使用自动修复脚本

在项目根目录打开 PowerShell：

```powershell
# 完整修复（包括重新安装）
.\scripts\fix-openclaw-module-error.ps1 -Force
```

脚本会自动完成：
- ✓ 停止 Gateway 服务
- ✓ 清理僵尸进程
- ✓ 卸载并重新安装 OpenClaw
- ✓ 启动 Gateway
- ✓ 验证运行状态

### 方法二：手动修复

如果自动脚本无法运行，请按以下步骤操作：

#### 1. 停止 Gateway

```powershell
openclaw gateway stop
```

#### 2. 清理端口占用

```powershell
# 检查端口 18789
$conn = Get-NetTCPConnection -LocalPort 18789 -ErrorAction SilentlyContinue
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force
}
```

#### 3. 重新安装 OpenClaw

```powershell
# 卸载
npm uninstall -g openclaw

# 重新安装
npm install -g openclaw
```

#### 4. 启动 Gateway

```powershell
# 方式 A：后台启动（推荐）
Start-Process -WindowStyle Hidden -FilePath "openclaw" `
    -ArgumentList "gateway","run","--force","--allow-unconfigured"

# 方式 B：前台启动（用于调试）
openclaw gateway run --force --allow-unconfigured
```

#### 5. 验证

```powershell
# 等待几秒后检查
Start-Sleep -Seconds 5
Invoke-WebRequest -Uri "http://127.0.0.1:18789/healthz" -UseBasicParsing
```

如果返回 `{"ok":true,"status":"live"}`，说明修复成功。

## 预防措施

### 1. 使用启动脚本

为避免每次手动启动，可以使用提供的启动脚本：

```powershell
.\scripts\start-gateway-windows.ps1
```

### 2. 定期检查更新

```powershell
# 检查当前版本
openclaw --version

# 更新到最新版本
npm update -g openclaw
```

### 3. 清理旧版本

如果频繁遇到此问题，建议完全清理后重装：

```powershell
# 1. 停止所有 OpenClaw 进程
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'openclaw'
} | Stop-Process -Force

# 2. 卸载
npm uninstall -g openclaw

# 3. 清理缓存
npm cache clean --force

# 4. 重新安装
npm install -g openclaw
```

## 常见问题

### Q: 为什么会出现文件哈希不匹配？

A: OpenClaw 使用 Vite 构建，每次构建会生成带哈希的文件名（如 `server-methods-DSL6KpJ1.js`）。如果：
- npm 更新过程中断
- 多个版本混合安装
- 文件系统缓存问题

就会导致引用的哈希与实际文件不匹配。

### Q: 重新安装会丢失配置吗？

A: 不会。OpenClaw 的配置文件存储在 `~/.openclaw/` 目录，重新安装不会影响：
- `openclaw.json`（主配置）
- 插件配置
- 频道登录状态
- 本地数据

### Q: 能否使用管理员权限安装 Gateway 服务？

A: 可以，但不推荐。使用管理员权限可以安装 Windows 计划任务：

```powershell
# 以管理员身份运行 PowerShell
openclaw gateway install
openclaw gateway start
```

但这需要管理员权限，且可能在某些企业环境中被禁止。使用 `openclaw gateway run` 方式更灵活。

### Q: Gateway 启动后多久可以使用？

A: 通常 5-10 秒。可以通过健康检查确认：

```powershell
# 循环检查直到就绪
do {
    $status = Invoke-WebRequest -Uri "http://127.0.0.1:18789/healthz" `
        -UseBasicParsing -ErrorAction SilentlyContinue
    if ($status.StatusCode -eq 200) {
        Write-Host "Gateway 就绪！"
        break
    }
    Start-Sleep -Seconds 1
} while ($true)
```

## 相关文档

- [Windows 进程启动问题排查指南](./WINDOWS_PROCESS_TROUBLESHOOTING.md)
- [OCT-Agent 安装与升级说明](./DESKTOP_INSTALL_AND_UPGRADE_GUIDE.md)
- [问题修复指南](../FIX_ISSUE.md)

## 获取帮助

如果以上方法都无法解决问题：

1. **收集诊断信息**：
   ```powershell
   # 检查 OpenClaw 版本
   openclaw --version
   
   # 检查 dist 目录文件
   Get-ChildItem "$env:APPDATA\npm\node_modules\openclaw\dist" -Filter "server*.js"
   
   # 查看 Gateway 日志
   Get-Content "$env:USERPROFILE\.openclaw\logs\gateway.log" -Tail 50
   ```

2. **提交 Issue**：
   - 附上错误信息截图
   - 附上 OpenClaw 版本
   - 附上 dist 目录文件列表
   - 描述具体的操作步骤

---

**最后更新**：2026-05-03
