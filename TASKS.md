# AwarenessClaw 任务清单

> 完成一项就打 ✅，附上完成日期。未完成的保持 ⬜。

---

## P1 — 基础骨架（✅ 已完成 2026-03-29）

- [x] Electron + React + Tailwind 项目初始化
- [x] 5 步安装向导（欢迎→安装→模型→记忆→完成）
- [x] 侧边栏导航（聊天/记忆/通道/技能/设置）
- [x] 13 个模型厂商卡片选择器（API 信息已验证）
- [x] 设置页模型切换弹窗
- [x] 设置页所有开关持久化（localStorage + openclaw.json 同步）
- [x] macOS arm64 打包 + 自动启动
- [x] 自动检测/安装 Node.js
- [x] Awareness 插件自动安装
- [x] 本地守护进程自动启动
- [x] 设备认证流程（可选云端）
- [x] Awareness logo (icns) 生成
- [x] GitHub 仓库初始化 + 推送

---

## P2 — 核心功能（进行中）

### 聊天
- [ ] **聊天 UI 后端接入**：`openclaw agent` CLI 返回 "Message ordering conflict"，需排查 Gateway session 冲突问题
- [ ] **流式输出（streaming/SSE）**：用户看到逐字生成，而非等完整回复才显示
- [ ] **聊天气泡 Markdown 渲染**：支持代码块高亮、表格、列表、链接
- [ ] **模型切换下拉**：未配置 API Key 的厂商显示"需配置"badge，已配置的显示"已激活"
- [ ] **文件/图片上传**：拖拽 + 点击附件，传给 agent
- [ ] **会话历史**：侧边栏显示历史会话列表，可切换
- [ ] **新建会话**：清空当前对话，开启新 session

### 模型配置
- [ ] **模型激活状态 badge**：每个厂商卡片上显示"已配置 ✅"或"需配置 🔑"
- [ ] **未配置厂商点击后提示输入 API Key**
- [ ] **测试连接按钮**：发送测试请求验证 API Key 有效

### 记忆
- [ ] 记忆页接入本地守护进程 MCP API（awareness_lookup / awareness_recall）
- [ ] 语义搜索真正调用后端
- [ ] 感知信号面板（矛盾/模式/共鸣）接入真实数据

### 通道
- [ ] 通道配置写入 openclaw.json（Telegram Token 等）
- [ ] 测试连接功能（验证 Token 有效性）
- [ ] 通道状态实时显示（已连接/断开）

### 定时任务（Cron）
- [ ] Cron 可视化管理页面（列表 + 添加 + 删除）
- [ ] 调用 `openclaw cron list/add/remove` CLI
- [ ] Heartbeat 开关 + 频率配置

### 系统管理
- [x] Gateway 启动/停止/重启按钮
- [x] Gateway 状态实时检测
- [x] 日志查看器弹窗
- [ ] 系统诊断（`openclaw doctor` 展示）

### 升级提醒
- [ ] **强提醒**（弹窗）：OpenClaw 有重大更新时弹出，用户可选"立即升级 / 下次提醒 / 永不提醒"
- [ ] **弱提醒**（tooltip）：每次打开时顶部显示更新提示条，用户手动关闭才消失
- [ ] 检测 OpenClaw 版本 vs npm latest
- [ ] 检测 Awareness 插件版本
- [ ] 检测 AwarenessClaw 桌面端版本（electron-updater）

---

## P3 — 进阶功能

### 多 Agent 管理
- [ ] Agent 列表页面
- [ ] Agent 创建向导
- [ ] 路由绑定可视化编辑器

### 设备节点
- [ ] macOS 系统托盘集成
- [ ] iOS/Android 扫码配对 UI

### 语音 & 视觉
- [ ] TTS 语音输出（消息播放按钮）
- [ ] STT 语音输入（麦克风按钮）
- [ ] 图片理解（拖拽图片自动发送分析）
- [ ] 截图分析

### MCP
- [ ] MCP 服务器列表管理
- [ ] MCP 工具浏览

### 其他
- [ ] 费用统计面板
- [ ] 每日记忆摘要（日历视图）
- [ ] MEMORY.md 富文本编辑器
- [ ] 配置导入/导出

---

## P4 — 长尾功能

- [ ] 更多通道（Teams, Twitch, Zalo, Nextcloud）
- [ ] 团队记忆（多用户 + 角色隔离）
- [ ] Agent 权限管理（工具白名单/黑名单）
- [ ] 自定义技能创建
- [ ] MCP 资源浏览
- [ ] 多语言 UI 完善（日/韩/英/中）

---

## 技术债务 & Bug

- [ ] `openclaw agent -m "..." --json` 返回 "Message ordering conflict" — 需要正确的 session 管理或改用其他 API
- [ ] `.bash_profile` 加载报错（`/Users/edwinhao/.cargo/env: No such file or directory`）— 在打包环境中忽略
- [ ] `plugins.allow` 警告 — 需在 openclaw.json 中设置 `plugins.allow: ["openclaw-memory"]`
- [ ] Setup 安装步骤中的旧 PROVIDERS 数组残留代码需清理
- [ ] Windows / Linux 打包未测试
