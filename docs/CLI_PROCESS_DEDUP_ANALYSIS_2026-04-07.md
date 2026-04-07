# OpenClaw CLI 重复进程深度分析报告

**日期**：2026-04-07  
**状态**：P0 短期修复已实施，P1-P4 待规划

---

## 1. 问题现象

AwarenessClaw 桌面端启动后，系统同时出现 4-6 个 `openclaw channels list`、2-3 个 `openclaw agents bindings --json`、多个 `openclaw gateway status` 等 CLI 进程。每个进程加载全部插件（feishu_doc/chat/wiki/drive、device-pair、phone-control、awareness-memory 等十几个），单次耗时 130 秒以上。多进程并发抢 CPU，导致系统卡顿。

---

## 2. 根因分析

### 2.1 OpenClaw CLI 不是为 GUI 设计的

OpenClaw 是 CLI 工具，每次执行任何命令都要：

1. 启动新的 Node.js 进程
2. **加载全部已安装插件**（15-30 秒，插件多时 130 秒+）
3. 初始化完成后才执行实际命令
4. 执行完毕后进程退出

这个"冷启动 → 加载 → 执行 → 退出"模式对 CLI 用户没问题（一次执行一条命令），但对 GUI 桌面端是灾难——GUI 需要同时获取多种数据。

### 2.2 前端多组件独立触发 CLI 调用

App.tsx 的页面渲染方式是条件渲染（`{currentPage === 'channels' && <Channels />}`），同一时刻只有一个页面被 mount。但重复进程仍然产生，原因：

1. **App.tsx 启动时**调用 `startupEnsureRuntime()`（含 `gateway status` + `agents list`）和 `agentsList()`（ghost-id 检测）
2. **Channels 页 mount** 时调用 `channelListConfigured()` + `channelGetRegistry()`
3. **Agents 页 mount** 时调用 `agentsList()` + `channelListConfigured()` + `channelGetRegistry()`
4. **Skills 页 mount** 时调用 `skill:local-info`（→ `skills list --json`）
5. **TaskCenter 页 mount** 时调用 `agentsList()`
6. **用户快速切换页面**，每次 mount 触发独立的 CLI 调用

结果：app 启动后 5 秒内，同时有 3-6 个 CLI 进程在跑。

### 2.3 架构图

```
┌─────────── 前端（React）──────────────┐
│                                        │
│  App.tsx mount                         │  ← 启动时：gateway status + agents list
│    ├─ startupEnsureRuntime()           │
│    └─ agentsList() (ghost-id sweep)    │
│                                        │
│  用户看到的当前页面：                    │
│    ├─ Channels.tsx mount               │  ← channelListConfigured() + channelGetRegistry()
│    ├─ Agents.tsx mount                 │  ← agentsList() + channelListConfigured()
│    ├─ Skills.tsx mount                 │  ← skill:local-info → skills list --json
│    ├─ TaskCenter.tsx mount             │  ← agentsList()
│    └─ Automation.tsx mount             │  ← cronList()
│                                        │
└──────────── IPC 调用 ─────────────────┘
                  │
                  ▼
┌─────────── 主进程（Electron）─────────┐
│                                        │
│  每个 IPC handler 独立 spawn 一个      │
│  openclaw CLI 进程                     │
│                                        │
│  channel:list-configured               │
│    └─ spawn: openclaw channels list    │  ← 130s 加载插件
│  agents:list                           │
│    └─ spawn: openclaw agents list      │  ← 130s 加载插件
│  skill:local-info                      │
│    └─ spawn: openclaw skills list      │  ← 130s 加载插件
│                                        │
└───────────────────────────────────────┘
```

---

## 3. CLI 调用热点

### 3.1 全部 CLI 调用来源

| CLI 命令 | 调用来源 | 触发时机 | 超时 | 已去重？ |
|----------|---------|---------|------|---------|
| `openclaw channels list` | channel:list-configured, channel:list-supported | 页面 mount（Channels/Agents） | 20s | ✅ channelsListDeduped |
| `openclaw agents list --json --bindings` | agents:list, startup health, App.tsx ghost-id | 页面 mount + 启动 | 15s | ✅ agentsListDeduped |
| `openclaw gateway status` | gateway:status, channel setup, startup, logs | Settings/启动 | 15s | ✅ gatewayStatusDeduped |
| `openclaw skills list --json` | skill:local-info | Skills 页 mount | 8s | ⚠️ 单源，8s 超时保护 |
| `openclaw cron list` | cron:list | Automation 页 mount | 20s | ✅ dedupedCronList |
| `openclaw gateway restart` | 通道保存、升级、聊天 fallback | 用户操作触发 | 20s | ❌ fire-and-forget |
| `openclaw channels capabilities --channel all --json` | channel:get-registry | 通道页 mount | 15s | ❌ 单次 |
| `openclaw agents bind/unbind` | agents:bind/unbind, channel:save | 用户操作触发 | 30s | N/A 写操作 |

### 3.2 mount 时 IPC 调用总览

| 页面 | mount 时触发的 IPC | 涉及的 CLI 命令 |
|------|-------------------|----------------|
| App.tsx (根) | startupEnsureRuntime(), agentsList() | gateway status, agents list |
| Dashboard | 无 CLI 调用 | — |
| Channels | channelListConfigured(), channelGetRegistry() | channels list, channels capabilities |
| Agents | agentsList(), channelListConfigured(), channelGetRegistry() | agents list, channels list |
| Skills | skill:local-info | skills list --json |
| Automation | cronList() | cron list |
| TaskCenter | agentsList() | agents list |
| Settings | detectEnvironment() | 无 CLI（只检查 Node/npm 版本） |
| Memory | memoryCheckHealth() | 无 CLI（用 MCP 协议） |
| Models | models:read-providers | 无 CLI（直接读 openclaw.json） |

---

## 4. 已实施修复（P0 短期）

### 4.1 channels list 去重锁（04fcd3c）

**文件**：`electron/ipc/register-channel-list-handlers.ts`

```typescript
let channelsListInflight: Promise<string | null> | null = null;

function channelsListDeduped(timeoutMs: number): Promise<string | null> {
  if (channelsListInflight) return channelsListInflight;
  channelsListInflight = deps.readShellOutputAsync('openclaw channels list 2>&1', timeoutMs)
    .finally(() => { channelsListInflight = null; });
  return channelsListInflight;
}
```

效果：之前 6 个并发进程 → 现在 1 个。

### 4.2 agents list 去重锁 + 本地文件快速路径

**文件**：`electron/ipc/register-agent-handlers.ts`

- 先从 openclaw.json 直接读取 agents 和 bindings 数据立即返回
- CLI 调用加去重锁，复用已有 Promise

### 4.3 gateway status 去重锁 + HTTP ping 替代

**文件**：`electron/ipc/register-gateway-handlers.ts`

- 优先 HTTP GET `http://localhost:18789/` 检测 Gateway 是否存活（毫秒级）
- CLI 调用加去重锁作为 fallback

---

## 5. 优化路线图

### P0 短期（已完成）
- [x] `channels list` 去重锁
- [x] `agents list` 去重锁 + 本地读取快速路径
- [x] `gateway status` 去重锁 + HTTP ping 替代

### P1 中期（1-2 天）
- [ ] 所有查询类命令改为直接读 openclaw.json + 目录扫描
  - `agents list` → 读 `openclaw.json` 的 `agents` + `bindings` 字段
  - `channels list` → 读 `openclaw.json` 的 `channels` 字段（已部分实现）
  - `skills list` → 读 `~/.openclaw/workspace/skills/` 目录 + 解析 SKILL.md frontmatter
  - `cron list` → 读 cron 配置文件
- [ ] `gateway status` 完全改为 HTTP `localhost:18789/health`（不走 CLI）

### P2 中期（1 周）
- [ ] 前端组件共享数据层（store/context），避免多组件各自调 IPC
- [ ] 页面切换时复用已有数据，只在超过 TTL 后刷新

### P3 长期（1-2 周）
- [ ] Gateway WebSocket 管理 API：通过 Gateway WS 调用 agents/channels/skills 等管理操作
- [ ] 桌面端实现完整的 Gateway WS 客户端（当前只覆盖 chat）

### P4 长期（取决于上游）
- [ ] 推动 OpenClaw 团队加 `--no-plugins` / `--skip-plugins` flag
- [ ] 推动 Gateway 暴露 REST 管理端点（`GET /api/agents`、`GET /api/channels`）
- [ ] 推动 OpenClaw daemon 模式（一次加载，持续服务）

### 目标架构

```
当前架构（CLI 驱动）：
┌─────────┐     IPC      ┌──────────┐    spawn    ┌──────────┐
│ React   │ ──────────►  │ Electron │ ──────────► │ CLI 进程  │ × N
│ 前端    │              │ 主进程    │             │ (130s/个) │
└─────────┘              └──────────┘             └──────────┘

目标架构（Gateway 驱动）：
┌─────────┐     IPC      ┌──────────┐   WS/HTTP   ┌──────────┐
│ React   │ ──────────►  │ Electron │ ──────────► │ Gateway  │ (常驻)
│ 前端    │              │ 主进程    │  (毫秒级)    │ :18789   │
└─────────┘              └──────────┘             └──────────┘
                                                       │
                                        已加载全部插件，不需要重复加载
```

---

## 6. 已有去重/缓存机制一览

| 机制 | 文件 | 说明 |
|------|------|------|
| `channelsListInflight` | register-channel-list-handlers.ts | channels list 去重锁 |
| `agentsListInflight` | register-agent-handlers.ts | agents list 去重锁 |
| `gatewayStatusInflight` | register-gateway-handlers.ts | gateway status 去重锁 |
| `channelStatusCache` | register-channel-list-handlers.ts | channels list 结果缓存（60s TTL） |
| `dedupedCronList()` | register-cron-handlers.ts | cron list 去重锁 |
| `dedupedChannelsAddHelp()` | register-channel-config-handlers.ts | channels add --help 进程生命周期缓存 |
| `acquireChannelLoginLock()` | openclaw-process-guard.ts | channels login 互斥锁 |
| `readConfiguredFromFile()` | register-channel-list-handlers.ts | 本地文件快速路径 |
| `verified-bins.json` | register-skill-handlers.ts | 技能二进制验证缓存 |
