# Mission Flow · Resume / Durability Design (rewritten 2026-04-18)

> **Status**: 设计稿 v2（v1 被 web search 推翻）
> **触发**：用户问 "openclaw 自己怎么做的？应该已经想到了吧？"
> **结论**：**我们的 MissionRunner 在重造 TaskFlow 的轮子**。下一轮应该对齐 OpenClaw 原生能力。

---

## 🔎 OpenClaw 2026 原生 durable / resume 能力

（来自 web search + 本地源码 verify）

### ✅ OpenClaw TaskFlow（2026.4.2 落地）

**官方定义**（docs.openclaw.ai）：
> "Task Flow is the flow orchestration substrate that sits above background tasks and manages durable multi-step flows with their own state, revision tracking, and sync semantics while individual tasks remain the unit of detached work."

**核心能力**：
- **Durable state**：flow state 在 Gateway 重启后**保留**
- **Managed-vs-mirrored sync modes**
- **Revision tracking**
- **`openclaw flows` CLI**：list / show / recover / cancel
  - `openclaw flows list` — 列所有 flow 状态
  - `openclaw flows show <id>` — 看单个 flow
  - `openclaw flows recover <flow-id>` — 从异常中断恢复
  - `openclaw flows cancel` — sticky cancel intent（停止调度新 child，但不强杀正在跑的）
- **Child task spawning is also durable**

**Gateway WS RPC**：应该有对应的 `tasks_flow_spawn` / `flows.create` / `flows.recover` 等调用（待 verify，S1-T0 反向工程没做到这层）。

### ⚠️ OpenClaw `sessions_spawn` 不 durable

核心限制（来自 issue 追踪）：
> "Sub-agents spawned via `sessions_spawn` use UUID-based session keys (`agent:<id>:subagent:<uuid>`), and when the gateway restarts, these sessions are **dead** — there's no way to resume them by a stable name/key."

Open issues，官方尚未修：
- [#62442 Gateway restart causes session state loss, requiring manual intervention](https://github.com/openclaw/openclaw/issues/62442)
- [#51814 Feature Request: Native Agent Wake-Up After Gateway Restart](https://github.com/openclaw/openclaw/issues/51814)
- [#50791 Auto-resume pending sessions after Gateway restart](https://github.com/openclaw/openclaw/issues/50791)
- [#26872 post-restart continuation](https://github.com/openclaw/openclaw/issues/26872)
- [#51917 Auto-resume unanswered sessions after gateway restart](https://github.com/openclaw/openclaw/issues/51917)
- [#19780 Persistent named sessions for sub-agents (durable thread context across gateway restarts)](https://github.com/openclaw/openclaw/issues/19780)
- [#66909 Doc Clarification: Do tasks automatically resume after gateway restart?](https://github.com/openclaw/openclaw/issues/66909)

**唯一可用的 thread-durable session**：
- `sessions_spawn` with `thread: true, mode: "session"`
- **仅 Discord 通道支持**（桌面端用不上）

---

## 🚨 我们当前实现的架构债

S1-T0 决策文档（[07-DECISION-LOBSTER-VS-TASKFLOW.md](./07-DECISION-LOBSTER-VS-TASKFLOW.md)）写的是 **"方案 B · TaskFlow + sessions_spawn + Streaming"**。

实际代码（`electron/mission/streaming-bridge.ts:74`）：
```ts
const result = await ws.chatSend(key, prompt, {...});
```
**我们用的是 `chat.send` RPC（普通 agent session）， 不是 `tasks_flow_spawn`，也不是 `sessions_spawn`**。

后果：
1. **完全没继承** OpenClaw TaskFlow 的 durable state
2. **完全没享受** `openclaw flows recover` CLI
3. **Mission Runner 是一个并行的 TaskFlow 山寨实现** — mission.json 存磁盘、step status 流转、idle timer … 全部是 OpenClaw 已经做了一遍的事
4. 这违反 AwarenessClaw CLAUDE.md "核心原则 #1 套壳不复刻" 和 "#2 复用优先，不重复造轮子"

---

## 📋 正确的 Resume 方案（重写）

### 阶段 0：立即验证（30 min，preview.6 前必做）

**反向工程 `openclaw flows` RPC + CLI**，搞清楚：
1. Gateway WS 协议里 `tasks_flow_spawn` / `flows.list` / `flows.recover` 的帧格式
2. Flow state 在磁盘 / SQLite 的实际结构（auxclawdbot/taskflow 仓库可能有线索）
3. 用 `openclaw gateway --log-level debug` 跑 `openclaw flows list` 抓 WS 帧
4. 确认 Flow 跑的 subagent session 在 gateway restart 后的行为

产出：`docs/features/team-tasks/OPENCLAW_FLOWS_API.md` —— 一份"当前我们能用的 OpenClaw Flows RPC 清单"。

如果 Flows API 不能 spawn 任意 agent 做 step → 退回只做 L1 L2（见下）
如果能 → 进入阶段 1（重写 Runner）

### 阶段 1 · 首选：Runner 迁到 OpenClaw Flows（~1-2 天）

**改造**：
- `electron/mission/mission-runner.ts` 内部用 `tasks_flow_spawn` 发起 flow
- 每个 subtask → flow 里的一个 task
- 状态持久化由 OpenClaw 管（mission.json 变成只是 UI 缓存）
- Resume：`mission:resume` IPC → `openclaw flows recover <flowId>`

**收益**：
- 自动获得 Gateway 重启 durable（上游保证）
- `openclaw flows list/show/cancel` 免费得到 ops 能力
- 删掉自己的 idle timer / sweep / hydrateFromDisk（OpenClaw 管）

**风险**：
- Flows API 可能不支持"每个 subtask 指定不同 agentId"（需 verify）
- TaskFlow 的 streaming / delta 格式可能和我们 `event:chat` delta 不一样
- 大重构，影响 375 个测试

### 阶段 2 · fallback：保留 chat.send，做薄 resume（~5h）

**只做** "AwarenessClaw 重启，Gateway 活着" 这个最大用户场景（80%+ 场景）。

**L1 · re-attach live session**：
- AwarenessClaw 启动时对 status=running 的 mission：
  - 读 step 的 sessionKey + runId
  - `gateway.chatHistory(sessionKey)` 看历史
  - 末尾 `final` → writeArtifact + spawnNextStep
  - 还 active → `gateway.subscribe(sessionKey)` 继续订阅 delta
  - Dead → 降级走 sweep 标 failed

**L2 · auto-retry on transient error**：
- network_error / gateway-5xx / timeout → backoff 1s/2s/4s 重试 max 3 次
- permission_denied / context_overflow → 直接 fail

**明确不做**：
- ❌ Gateway 重启 session 恢复（上游限制 #62442）
- ❌ 关 AwarenessClaw 继续跑（Electron main 死了，需要 daemon 化，见下）

### 阶段 3 · 不做：Daemon 化（L3 原设计）

**原 L3 方案**（独立 Runner daemon 进程）= 又一次重造 OpenClaw Gateway 已做的事。

**正确姿势**：
- OpenClaw Gateway 已经是 daemon（Windows Scheduled Task / macOS launchd）
- 我们的 mission 应该跑在 Gateway 的 TaskFlow 里 → Gateway 活着任务就活着
- AwarenessClaw UI 只是 TaskFlow 的 viewer

这正是阶段 1 的目标。**不要**写独立 daemon。

---

## 📌 推荐下一轮 scope

### 方案 A（激进 / 正确但风险大）

**1.5 - 2 天**做：
1. 阶段 0 反向工程 Flows API（30 min）
2. 阶段 1 Runner 迁到 OpenClaw Flows（大重构）
3. 删掉自己的 sweep / hydrateFromDisk / idle timer
4. 所有 375 个测试适配

### 方案 B（保守 / 快速 ship）

**~5h** 做：
1. 阶段 0 反向工程（30 min）
2. 阶段 2 L1 + L2（re-attach + auto-retry）
3. 明确记录**技术债 ticket**：Runner 应该迁到 OpenClaw Flows（后续 0.4.x）

### 方案 C（推荐）

**先 B，后 A**：
- 短期 preview.6 = 方案 B (L1+L2 用 chat.history + subscribe)
- 0.4.0 = 方案 A（Flows 迁移，大版本可以接受 breaking）

---

## 🔗 Sources（Web search 2026-04-18）

- [OpenClaw Task Flow Docs](https://docs.openclaw.ai/automation/taskflow)
- [OpenClaw 2026.4.2 Release Notes — Task Flows Land](https://www.openclawplaybook.ai/blog/openclaw-2026-4-2-release-task-flows-android-assistant/)
- [OpenClaw 2026.4.2 Migration Guide (Efficient Coder)](https://www.xugj520.cn/en/archives/openclaw-2026-migration-configuration-security-task-flow.html)
- [OpenClaw Sub-Agents Docs](https://docs.openclaw.ai/tools/subagents)
- [OpenClaw Cheatsheet 2026 v2026.4.14](https://openclawcheatsheet.com/)
- [OpenClaw Background Tasks Guide](https://remoteopenclaw.com/blog/openclaw-background-tasks-guide)
- [Issue #62442 Gateway restart causes session state loss](https://github.com/openclaw/openclaw/issues/62442)
- [Issue #51814 Native Agent Wake-Up After Gateway Restart](https://github.com/openclaw/openclaw/issues/51814)
- [Issue #50791 Auto-resume pending sessions after Gateway restart](https://github.com/openclaw/openclaw/issues/50791)
- [Issue #19780 Persistent named sessions for sub-agents](https://github.com/openclaw/openclaw/issues/19780)
- [Issue #66909 Doc Clarification: Do tasks auto-resume?](https://github.com/openclaw/openclaw/issues/66909)
- [auxclawdbot/taskflow (markdown/SQLite-backed task mgr)](https://github.com/auxclawdbot/taskflow)

---

## 🧾 给用户的诚实汇报

**一句话**：OpenClaw 2026.4.2 已经给出了 TaskFlow 这个 durable substrate，我们的 MissionRunner 却绕开它自己搭了一个 mission.json + chat.send 的平行实现 —— 用户看到的 "关 app 就丢 mission" 其实是我们自己造的限制，不是 OpenClaw 的限制。正确的下一轮应该先**反向工程 `openclaw flows` API**，然后决定是重写对齐还是打薄 resume 补丁。
