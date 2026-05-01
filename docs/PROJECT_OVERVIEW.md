# OCT-Agent 项目总览

最后更新：2026-04-02

## 1. 项目定位

OCT-Agent 是一个面向普通用户和开发者的桌面 AI Agent 产品。

它并不是从零实现一个新的大模型运行时，而是把下面几层能力整合成一个可直接使用的应用：

- OpenClaw：负责 Agent、工具调用、Gateway、Skills、Channels、Cron 等运行时能力
- Awareness Memory：负责长期记忆、知识卡片、感知信号、跨会话上下文
- Electron Desktop：负责安装、配置、GUI、诊断、托盘、系统集成
- React Frontend：负责聊天工作台、记忆中心、渠道管理、多 Agent 管理等交互界面

一句话理解：

> OCT-Agent = 一个带长期记忆、可连接外部渠道、可视化配置的 OpenClaw 桌面发行版。

---

## 2. 仓库结构

这是一个 monorepo，目前主要包含两个工作区：

```text
OCT-Agent/
├─ docs/                         项目文档
├─ packages/
│  ├─ cli/                       CLI 安装器 / 初始化工具
│  └─ desktop/                   Electron + React 桌面应用
├─ README.md
└─ package.json
```

### 2.1 根目录

- `README.md`
  对外介绍项目定位、安装方式和总体特性
- `package.json`
  声明 workspace，并提供根级脚本，如 `dev:desktop`、`build:desktop`
- `docs/`
  存放架构、安装、兼容性和冒烟测试文档

### 2.2 `packages/cli`

CLI 是“命令行安装通道”，面向高级用户和自动化场景。

主要职责：

- 检测本机环境
- 安装 OpenClaw
- 安装 Awareness Memory 插件
- 启动本地 daemon
- 可选完成设备认证
- 配置模型
- 写入初始化配置

关键文件：

- `bin/awareness-claw.mjs`
- `src/index.mjs`
- `src/detect.mjs`
- `src/installer.mjs`
- `src/plugin-setup.mjs`
- `src/daemon.mjs`
- `src/model-config.mjs`
- `src/config-writer.mjs`

### 2.3 `packages/desktop`

桌面端是当前产品主入口，整体上可以拆成三层：

```text
packages/desktop/
├─ electron/                     主进程、系统集成、IPC
├─ src/                          React 页面与组件
├─ resources/                    应用图标资源
├─ scripts/                      打包与调试脚本
└─ package.json
```

---

## 3. 桌面端代码结构

### 3.1 主进程层：`packages/desktop/electron`

这一层负责“桌面应用和 OpenClaw 运行时之间的桥接”。

核心文件：

- `main.ts`
  Electron 主入口，负责窗口创建、启动期自修复、托盘、IPC 注册
- `preload.ts`
  暴露 `window.electronAPI` 给前端使用
- `doctor.ts`
  系统诊断与自动修复
- `local-daemon.ts`
  本地 daemon 启停、健康检查、等待就绪
- `gateway-ws.ts`
  与 Gateway 建立 WebSocket 连接，用于渠道消息和实时事件
- `channel-registry.ts`
  渠道元数据注册表，支持内置渠道和从 OpenClaw 动态发现渠道
- `desktop-openclaw-config.ts`
  OpenClaw 配置合并、清洗、敏感字段处理

### 3.2 IPC 领域划分：`packages/desktop/electron/ipc`

`ipc/` 目录按业务领域拆分，每个文件负责一组 `ipcMain.handle(...)` 注册。

| 模块 | 作用 |
| --- | --- |
| `register-setup-handlers.ts` | 安装、初始化、bootstrap |
| `register-chat-handlers.ts` | 聊天请求、流式返回、审批、工具调用事件 |
| `register-memory-handlers.ts` | 记忆搜索、知识卡片、daily summary、健康检查 |
| `register-gateway-handlers.ts` | Gateway 状态、启动、停止、重启 |
| `register-channel-config-handlers.ts` | 渠道配置读写与动态注册表 |
| `register-channel-list-handlers.ts` | 已配置渠道列表、支持渠道列表 |
| `register-channel-setup-handlers.ts` | 渠道一键连接、插件安装、扫码登录、Agent 绑定 |
| `register-channel-session-handlers.ts` | 渠道会话历史与回复 |
| `register-agent-handlers.ts` | 多 Agent 列表、创建、删除、绑定、工作区文件 |
| `register-skill-handlers.ts` | Skill 搜索、安装、卸载、配置 |
| `register-cron-handlers.ts` | 定时任务列表、增加、删除 |
| `register-config-io-handlers.ts` | 配置导入导出 |
| `register-runtime-health-handlers.ts` | 启动期运行时检查与修复 |
| `register-app-utility-handlers.ts` | 日志、Dashboard URL、平台工具能力 |
| `register-app-runtime-handlers.ts` | 与桌面运行时生命周期相关的辅助操作 |

### 3.3 前端层：`packages/desktop/src`

这一层是 React 应用，负责产品界面和状态管理。

主要结构：

```text
src/
├─ App.tsx                       前端总入口
├─ main.tsx                      React 启动入口
├─ pages/                        页面级功能
├─ components/                   通用 UI 组件
├─ lib/                          store、i18n、memory、usage 等
├─ assets/                       logo 等前端资源
└─ test/                         Vitest 测试
```

### 3.4 前端页面职责

| 页面 | 作用 |
| --- | --- |
| `Setup.tsx` | 首次安装向导 |
| `Dashboard.tsx` | 聊天工作台、文件附件、工具调用、统一收件箱 |
| `Memory.tsx` | 记忆搜索、知识卡片、感知信号、时间线 |
| `Channels.tsx` | Telegram/WhatsApp/WeChat 等渠道接入 |
| `Skills.tsx` | Skills 浏览、安装、配置 |
| `Automation.tsx` | Cron 自动化和 heartbeat |
| `Agents.tsx` | 多 Agent 管理和工作区文件编辑 |
| `Settings.tsx` | 模型、Gateway、权限、Cloud、Doctor、日志等系统设置 |

---

## 4. 运行架构

可以把当前系统理解为四层：

```text
用户界面层
  React 页面与组件

桌面桥接层
  Electron main + preload + IPC handlers

Agent 运行时层
  OpenClaw / Gateway / Skills / Channels / Agents / Cron

长期记忆层
  Awareness Memory plugin + local daemon / cloud memory
```

各层分工如下：

- React 负责用户交互和页面展示
- Electron 负责把 GUI 操作翻译成系统命令、OpenClaw 配置写入和 IPC 请求
- OpenClaw 负责具体 Agent 执行、渠道接入、Skill 调用和 Gateway 服务
- Awareness Memory 负责长期上下文、知识沉淀和感知信号

---

## 5. 产品功能

### 5.1 一键安装与环境修复

应用首次启动时会尽可能自动完成：

- 检测 Node.js 和 OpenClaw 是否已安装
- 安装缺失依赖
- 安装 Awareness Memory 插件
- 启动本地 daemon
- 生成并修复 `~/.openclaw/openclaw.json`
- 在后续启动时继续做健康检查和自修复

### 5.2 聊天工作台

Dashboard 是产品核心页面，支持：

- 与主 Agent 对话
- 实时流式输出
- Thinking 过程展示
- Tool call 状态展示
- 审批类工具操作
- 文件上传与预览
- 多会话持久化
- 项目目录上下文
- Agent 切换

### 5.3 长期记忆

Memory 页面聚焦“Agent 记住什么、如何被召回”。

用户可以：

- 搜索历史知识和对话沉淀
- 查看 knowledge cards
- 查看 perception signals
- 查看 daily summary
- 检查 memory daemon 是否在线
- 选择本地记忆或云记忆模式

### 5.4 外部渠道接入

Channels 页面提供多渠道接入能力，例如：

- Telegram
- WhatsApp
- WeChat
- Signal
- iMessage

渠道接入通常包括：

1. 安装对应 OpenClaw 插件
2. 添加渠道配置
3. 执行登录流程
4. 扫码或输入凭据
5. 绑定到主 Agent 或指定 Agent

### 5.5 多 Agent 管理

Agents 页面允许把“一个 AI 助手”扩展成“多个有分工的 AI 助手”。

支持能力：

- 创建 Agent
- 删除 Agent
- 设置名字、emoji、头像、主题
- 绑定渠道
- 编辑 Agent 工作区文件

工作区文件包括：

- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `MEMORY.md`
- `AGENTS.md`

### 5.6 Skills 和自动化

Skills 页面负责扩展能力，Automation 页面负责计划任务。

具体包括：

- 从技能市场搜索和安装 skill
- 管理 skill 配置
- 创建 cron 定时任务
- 开启 heartbeat 定时探活
- 用固定频率驱动 Agent 自动执行任务

### 5.7 系统运维

Settings 页面承担“桌面控制台”的角色，包含：

- 模型提供商和模型选择
- Gateway 启停与日志查看
- 配置导入导出
- 权限管理
- 插件和 hooks 管理
- Cloud Memory 认证与连接
- Doctor 诊断与自动修复
- 工作区文件编辑
- 安全与用量信息

---

## 6. 用户使用流程

下面是一个典型用户从安装到长期使用的完整路径。

### 6.1 首次启动

用户下载桌面应用并打开后，先看到 Setup Wizard。

系统会依次执行：

1. 检测环境
2. 安装 Node.js
3. 安装 OpenClaw
4. 安装 Awareness Memory 插件
5. 启动本地 daemon
6. 选择模型提供商与模型
7. 选择记忆模式

### 6.2 完成初始化

Setup 完成后，前端会把状态写入本地存储，并同步 OpenClaw 配置。

随后应用进入主工作台，默认打开 Dashboard。

### 6.3 开始对话

用户可以直接：

- 输入问题
- 上传文件
- 指定项目目录
- 切换 Agent
- 观察执行状态、工具调用、流式输出

### 6.4 启用长期记忆

随着对话进行，系统会自动进行 recall 和 capture。

用户可以去 Memory 页面查看：

- 记忆是否成功写入
- 哪些知识被提炼成卡片
- 最近有哪些重要事项或感知信号

### 6.5 连接外部渠道

当用户希望 Agent 处理外部消息时，可以去 Channels 页面完成渠道接入。

完成后，外部消息会进入统一收件箱，用户可以在桌面端查看和回复。

### 6.6 扩展和分工

随着使用深入，用户可以：

- 安装新技能
- 新建多个 Agent
- 为不同渠道绑定不同 Agent
- 配置自动化任务

这样产品会从“一个聊天助手”逐步演化成“一个持续工作的多 Agent 系统”。

---

## 7. 核心流程时序

### 7.1 启动时序

```text
App Launch
  -> Electron main.ts
  -> 修复 OpenClaw 配置 / Gateway 脚本
  -> 创建主窗口
  -> 注册 IPC handlers
  -> 尝试预启动 Gateway
  -> 前端 App.tsx 判断 setup 是否完成
  -> 若未完成：进入 Setup
  -> 若已完成：执行 runtime health check
  -> 进入主工作台
```

### 7.2 聊天时序

```text
用户发送消息
  -> Dashboard 调用 window.electronAPI.chatSend(...)
  -> preload 转发到 ipcMain
  -> register-chat-handlers.ts 接收请求
  -> 检查 Gateway 是否已启动
  -> 调用 OpenClaw / Gateway 执行 Agent
  -> 主进程持续转发 thinking、tool_call、stream chunk
  -> Dashboard 实时渲染输出
  -> 如有需要写入 Memory
```

### 7.3 渠道连接时序

```text
用户在 Channels 页面点击 Connect
  -> channel:setup IPC
  -> 安装渠道插件
  -> openclaw channels add
  -> openclaw channels login
  -> 桌面端展示二维码或状态
  -> 登录成功后自动绑定到 main Agent
  -> 渠道开始可收发消息
```

---

## 8. 关键文件速查

如果要快速熟悉代码，建议按下面顺序阅读：

1. `packages/desktop/electron/main.ts`
2. `packages/desktop/electron/preload.ts`
3. `packages/desktop/src/App.tsx`
4. `packages/desktop/src/pages/Setup.tsx`
5. `packages/desktop/src/pages/Dashboard.tsx`
6. `packages/desktop/electron/ipc/register-chat-handlers.ts`
7. `packages/desktop/electron/ipc/register-channel-setup-handlers.ts`
8. `packages/desktop/electron/ipc/register-agent-handlers.ts`
9. `packages/desktop/electron/doctor.ts`
10. `packages/desktop/src/lib/store.ts`

---

## 9. 新同学最需要先理解的几点

- 这是一个桌面发行版，不是单纯的 React 应用
- 业务核心不在前端 UI，而在 Electron 和 OpenClaw 的桥接层
- Setup、Gateway、daemon、Memory 是启动链路的关键基础设施
- Dashboard 不是“聊天页”那么简单，它同时承担 Agent 执行状态面板和统一收件箱职责
- Channels、Agents、Skills、Automation 共同决定产品能否从单助手演化为多 Agent 系统
- Settings 和 Doctor 是稳定性保障，不是边角功能

---

## 10. 后续可继续补充的文档

如果要继续完善文档体系，推荐新增以下几份：

- 一份“启动链路详解”，专门讲 Setup、runtime health、Gateway、daemon
- 一份“IPC 接口字典”，列出每个 `window.electronAPI` 方法的入参和返回结构
- 一份“Channels 接入说明”，总结不同渠道的登录与绑定差异
- 一份“Agents 工作区说明”，解释 `SOUL.md`、`TOOLS.md` 等文件的职责
- 一份“Memory 数据流说明”，梳理 recall、capture、daily summary、perception 的路径
