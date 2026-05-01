# OCT-Agent 问题修复指南

如果您遇到了以下错误信息：

```
File: ~/.openclaw/openclaw.json Problem:
plugins.slots.memory: plugin not found: openclaw-memory Run: openclaw doctor --fix
```

请按照以下方法之一进行修复：

## 方法一：使用一键修复脚本（推荐）

如果您是在命令行中运行 OCT-Agent，可以使用内置的修复脚本：

```bash
# 在 OCT-Agent 项目目录中运行
npm run fix-openclaw
```

## 方法二：手动修复

如果您无法使用上述命令或者想了解具体修复步骤，请按以下步骤操作：

### 1. 清理旧配置

打开终端，依次运行以下命令：

```bash
openclaw doctor --fix
```

### 2. 卸载旧插件

```bash
openclaw plugins uninstall openclaw-memory
```

### 3. 重新安装插件

```bash
openclaw plugins install @awareness-sdk/openclaw-memory@latest --force --dangerously-force-unsafe-install
```

### 4. 重启 OpenClaw 服务

```bash
openclaw gateway restart
```

## 为什么会发生这个问题？

这个问题通常发生在 OCT-Agent 更新后，旧版本的 `openclaw-memory` 插件与新版本不兼容。通过重新安装最新版插件，可以解决此问题。

## 如果问题仍然存在

如果上述方法都无法解决问题，请尝试：

1. 完全关闭 OCT-Agent 应用
2. 重启您的计算机
3. 再次启动 OCT-Agent

如果问题依然存在，请联系技术支持或在 GitHub 上提交 issue。