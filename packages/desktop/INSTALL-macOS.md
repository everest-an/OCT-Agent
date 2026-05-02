# OCT-Agent 安装指南（macOS 测试版）

> 本文档说明如何在 macOS 上安装 OCT-Agent 测试版 DMG。
> 由于当前版本尚未通过 Apple 公证（Developer ID 签名 + 公证流程正在准备中），首次打开时 macOS 会提示"应用已损坏"或"无法验证开发者"。这是 macOS Gatekeeper 的正常行为，**app 本身是完好的**，只需要简单一步即可解除。

---

## 🚀 推荐方式（最简单）

DMG 里已经内置了一个一键修复脚本，**全程双击完成，不需要打开终端**。

### 步骤

1. **双击下载的 DMG 文件**（例如 `AwarenessClaw-0.2.x-arm64.dmg`）
2. DMG 窗口会弹出，里面有三个图标：
   - `AwarenessClaw.app`（应用本体）
   - `Applications`（指向"应用程序"文件夹的快捷方式）
   - `⚠️ 首次打开必读 First-Run Fix.command`（一键修复脚本）
3. **把 `AwarenessClaw.app` 拖到 `Applications` 文件夹**（和装普通 Mac app 一样）
4. **双击 `⚠️ 首次打开必读 First-Run Fix.command`**
   - 会弹出一个终端窗口显示进度
   - 显示 `✅ 完成！` 后按任意键关闭
5. 打开"**应用程序**"文件夹，双击 **OCT-Agent** 图标正常启动

> 💡 这个修复脚本只做一件事：运行 `xattr -cr` 清除 macOS 给下载文件打的"隔离"标记。它不会修改 app 本身，也不会留下任何后台进程。如果你担心安全，可以右键脚本 → 使用"文本编辑"打开查看源码（只有十几行 bash）。

### 如果双击脚本报错 "无法打开 First-Run Fix.command"

这是因为脚本本身也被 Gatekeeper 拦了。两种解决方法：

**方法 A（右键绕过）：**
- 在 DMG 窗口中**右键**点 `First-Run Fix.command` → **打开**
- 弹出的对话框选 **"打开"**（有些系统会多问一次 "macOS 无法验证开发者" → 再点打开）
- 脚本会正常运行

**方法 B（手动命令）：** 见下方"备用方式"。

---

## 🛠 备用方式（手动命令行，适合技术用户）

如果修复脚本不想用，或者你已经习惯用终端：

### 步骤

1. **双击 DMG → 拖 AwarenessClaw.app 到 Applications 文件夹**
2. 打开 **终端**（按 `⌘ + Space` → 输入 `Terminal` → 回车）
3. 复制下面这行命令，粘贴到终端按回车：
   ```bash
   xattr -cr /Applications/AwarenessClaw.app
   ```
4. 没有任何输出就是成功了。关掉终端
5. 打开"应用程序" → 双击 OCT-Agent

### 原理

- `xattr` 是 macOS 自带的命令，用来管理文件的扩展属性
- `-c` 清除所有扩展属性，`-r` 递归处理子目录
- 我们要清的属性叫 `com.apple.quarantine`，是 macOS 给所有从浏览器/邮件/AirDrop 下载来的文件自动打的标记，Gatekeeper 看到它就会弹"已损坏/无法验证"警告
- 清掉之后 app 就和你自己从源码编译的一样可信，可以正常双击打开

---

## ❓ 常见问题

### Q1：为什么要这么麻烦？别的 app 没这个问题？

因为别的 app 都走了 **Apple Developer ID 签名 + 公证** 流程（每年 $99 会费 + 每次打包上传到 Apple 服务器公证）。OCT-Agent 现在是内部测试版，还没走这个流程。**正式版发布时会走完整的签名+公证，届时这个文档就作废，用户下载直接双击打开**。

### Q2：修复脚本安全吗？

只有 16 行 bash 代码，做的事情完全等价于你在终端手动运行 `xattr -cr /Applications/AwarenessClaw.app`。不会：
- ❌ 下载任何东西
- ❌ 修改 app 内容
- ❌ 留下后台进程
- ❌ 修改系统设置

你可以用文本编辑器打开 `.command` 文件自己看。

### Q3：安装后报 "xxx 想要访问桌面文件夹"、"xxx 想使用网络"？

这些是 macOS 的权限弹窗，和"损坏"警告是两回事。选"允许"即可。OCT-Agent 需要这些权限是因为：
- **网络**：要和本地 Awareness 记忆守护进程 (localhost:37800) 通信
- **文件夹访问**：要读写你选的工作区目录里的 `.awareness/` 记忆库

### Q4：我装了之后想升级到新版本怎么办？

下载新 DMG，按同样步骤：拖新的 app 到 Applications（会覆盖旧的）→ 双击 `First-Run Fix.command` → 打开。你的记忆数据存在 `~/.awareness/`、`~/.openclaw/.awareness/` 和你选的各个工作区的 `.awareness/` 目录下，不会因为升级丢失。

### Q5：我想卸载怎么办？

1. "应用程序" → 把 OCT-Agent 拖到"废纸篓"
2. 默认到这一步就结束：聊天记录、记忆、API 配置、模型设置、已下载技能会保留在用户目录，不会被自动删除
3. 只有在你明确要"彻底清空本机数据"时，才手动执行删除（请先备份，并二次确认路径）：
   ```bash
   rm -rf ~/.awareness ~/.awarenessclaw ~/.openclaw/.awareness
   ```
4. （可选）清除本地 daemon 缓存：
   ```bash
   rm -rf ~/.npm/_npx/*/node_modules/@awareness-sdk
   ```

> 注意：如果你之前用过龙虾/OpenClaw 旧版本，相关旧记忆和聊天目录默认也不会被 OCT 的卸载流程删除。

### Q6：Windows / Linux 怎么装？

暂未发布。Linux AppImage 和 Windows EXE 在 roadmap 上，发布时会另外写文档。

---

## 📮 遇到问题

- 如果修复脚本和手动命令都解决不了"应用已损坏"，把你的 macOS 版本（Apple → 关于本机）+ 截图发给团队
- 一般性 bug 报告：带截图 + 控制台日志 → 开发者目录是 `~/.openclaw/logs/`

---

**最后更新**: 2026-04-11
**适用版本**: OCT-Agent ≥ 0.2.4（DMG 内置 fix-app.command 脚本）
