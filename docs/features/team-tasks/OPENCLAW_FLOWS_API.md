# OpenClaw Flows / TaskFlow API · 反向工程结论

> **日期**：2026-04-18（阶段 0）
> **OpenClaw 版本**：2026.4.15 (041266a)
> **调查方式**：读 `~/.npm-global/lib/node_modules/openclaw/dist/` 的 `.d.ts` + `.js`，跑 CLI `--help`，直接查 SQLite。
> **目标**：决定方案 A（重写为 TaskFlow）是否可行；如果不可行回退方案 B（chat.send + re-attach）。

---

## TL;DR — 一张图说清

```
                 ┌──────────────────────────────┐
                 │   我们现在在哪里（preview.5） │
                 │   Electron MissionRunner     │
                 │   → ws.chatSend(agent, goal) │
                 │   ✗ 不登记到 TaskFlow        │
                 │   ✗ Gateway 重启 session 死  │
                 └──────────────────────────────┘

                        ▲                       ▲
            ┌───────────┴──────┐     ┌──────────┴──────────┐
            │ 方案 B（保守）    │     │ 方案 A'（orchestrator）│
            │ 留 chat.send     │     │ 让 main agent 自己     │
            │ + re-attach      │     │   调 sessions_spawn    │
            │ + retry          │     │ + 我们读 sqlite       │
            │ 5h               │     │ 1-2 天               │
            └──────────────────┘     └──────────────────────┘

         ⚠ 原 prompt 的"方案 A：ws.tasks_flow_spawn()"不存在
          这个 RPC 只对 OpenClaw 插件进程内部开放
          外部客户端（我们的 Electron）永远调不到
```

---

## 5 个问题 · 逐一回答

### Q1: Gateway WS 有哪些 flow 相关 RPC（tasks_flow_spawn / flows.create / flows.recover / flows.list / flows.cancel 等）？格式？

**答**：**没有外部 WS RPC 能创建 / recover TaskFlow**。原 prompt 假设的 `tasks_flow_spawn` 不存在。

**证据**：

1. `grep tasks_flow_spawn ~/.npm-global/lib/node_modules/openclaw/dist` → **0 matches**
2. `grep tasks_flow_list|tasks_flow_show|tasks_flow_cancel|tasks_flow_recover` → **0 matches**
3. `openclaw tasks --help` 没有 `spawn` 子命令（只有 audit/cancel/flow/list/maintenance/notify/show）
4. `openclaw tasks flow --help` 只有 `list/show/cancel`（**没有 recover / create**）
5. `openclaw flows --help` → "command is unavailable because `plugins.allow` excludes 'flows'"。即使 allow 它也是 bundled plugin 的**只读查询 CLI**，不是创建 API

**TaskFlow 的实际创建路径**（在 OpenClaw 内部）：

```
Agent 在 system prompt 下被教会使用 sessions_spawn tool
   → agent 输出 tool_call({ name: "sessions_spawn", input: { task, agentId, ... } })
   → Gateway 路由到 spawnSubagentDirect(params, ctx)   // 插件 SDK 内部函数
   → task_runs 表 insert 一行 (runtime='subagent' 或 'acp')
   → task-mirrored 规则自动 upsert 一行到 flow_runs 表（sync_mode='task_mirrored'）
```

**Plugin SDK 内部** 还有第二条路径（`runtime-taskflow.types.d.ts`）：

```ts
// plugin runtime API — 只能在 OpenClaw 插件进程中调，Electron 调不到
const rt = pluginCtx.taskflow.bindSession({ sessionKey });
rt.createManaged({ controllerId, goal, ... });   // syncMode='managed'
rt.runTask({ flowId, agentId, task, ... });       // 在 flow 里起 task
rt.resume({ flowId, expectedRevision, ... });     // 恢复 waiting/blocked
rt.finish / fail / requestCancel / cancel(...)
```

**结论**：外部客户端**不能直接创建 TaskFlow**。必须：
- (a) 通过 agent 的 `sessions_spawn` 调用（agent 在 prompt 里自己发 tool_call）
- (b) 或写一个 OpenClaw 插件跑在 Gateway 进程里

### Q2: Flow 里的 subtask 能否指定不同 agentId（designer/coder/tester）？

**答**：**可以**，但只能通过 agent 自己的 `sessions_spawn` 调用来指定，我们不能在外部强制。

**证据**：

`plugin-sdk/src/agents/subagent-spawn.d.ts` line 15-34：

```ts
export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;      // ← 就是这个字段
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: SpawnSubagentMode;    // "run" | "session"
  cleanup?: "delete" | "keep";
  sandbox?: SpawnSubagentSandboxMode;
  lightContext?: boolean;
  expectsCompletionMessage?: boolean;
  attachments?: ...;
};
```

每次 sessions_spawn 调用都能传一个**不同** `agentId` → 每个 subtask 可以绑到不同 agent。

但：
- **是 agent 决定要不要这么做**，不是我们
- orchestrator agent 的 SOUL.md / system prompt 必须写清"routing rules"（哪类任务派给哪个 agent）
- 如果 agent hallucinate agentId，任务会静默失败（和我们 preview.2 的 "Agent id 必须严格匹配" 坑一样）

**实务上**：可以工作，但需要我们在 orchestrator agent 的 prompt 里硬编码 routing table。

### Q3: Flow 的 streaming delta 格式 vs 我们现在用的 event:chat delta — 兼容吗？

**答**：**每个 subtask 有自己的 `childSessionKey`，streaming delta 走那个 session 的 WS**，格式和 `chat.send` 的 delta **完全一样**。

**证据**：

1. `spawnSubagentDirect(...)` 返回：
   ```ts
   { status: "accepted", childSessionKey: "agent:worker:subagent:uuid", runId: "..." }
   ```
2. 订阅 `childSessionKey` 拿到的就是普通 `event:chat` delta（subagent 本身是 agent session）
3. **但 parent orchestrator session** 只会收到 "spawn accepted" note，**看不到**子 agent 的增量输出

所以我们的 Kanban UI 必须**并发订阅多个 session**：
- 订阅 orchestrator session 看 planning / handoff / 注释
- 从 `~/.openclaw/tasks/runs.sqlite` 读 `child_session_key`
- 对每个 child key 单独订阅拿 step 的 delta

`child_session_key` 是我们现有代码 `MissionStep.sessionKey` 的对应物 — 接口形状兼容。

### Q4: `openclaw flows recover <id>` 的语义：从最后 checkpoint 继续？重跑 failed task？

**答**：**这个命令不存在**（至少 2026.4.15 不存在）。用户 / web search 看到的"recover"可能指：

1. **`openclaw tasks flow` 没有 `recover`**，只有 `cancel/list/show`
2. **Plugin runtime 有 `resumeFlow(flowId, expectedRevision)`**（`task-flow-registry.d.ts` line 79-86）：
   ```ts
   // 只做 status: waiting/blocked → queued/running 的状态转换
   // 不会重跑 failed task，不会重发 tool call
   // Plugin SDK 层，外部调不到
   ```
3. **`openclaw flows ...`** bundled plugin（被 `plugins.allow` 排除）即使启用也可能只是查询 + cancel wrapper，不是 recover

**结论**：上一轮 web search 里说"`openclaw flows recover`"是**误读**。不存在这个能"从 Gateway 重启恢复"的 CLI 入口。

**真正的 durability 机制**（SQLite-backed）：
- Gateway 重启时 `loadTaskFlowRegistryStateFromSqlite()` 读回所有 flow state
- **状态 preserve**（revision / goal / currentStep / stateJson 都在）
- **但 runtime session 不恢复**：child_session_key 对应的 subagent session 已经死（issue #62442）
- 所以"recover"这个词在 OpenClaw 里意味着"**数据还在，进程不在**" — 和关 app 一样

### Q5: Flow 持久化存储在哪（~/.openclaw/flows/？SQLite？）？

**答**：**`~/.openclaw/flows/registry.sqlite`**（TaskFlow）+ **`~/.openclaw/tasks/runs.sqlite`**（Tasks）。

**完整 schema**：

```sql
-- ~/.openclaw/flows/registry.sqlite
CREATE TABLE flow_runs (
  flow_id TEXT PRIMARY KEY,
  shape TEXT,
  sync_mode TEXT NOT NULL DEFAULT 'managed',   -- managed | task_mirrored
  owner_key TEXT NOT NULL,                     -- 'agent:main:orch-8-xxx' 之类
  requester_origin_json TEXT,
  controller_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,         -- 乐观锁
  status TEXT NOT NULL,                        -- queued|running|waiting|blocked|succeeded|failed|cancelled|lost
  notify_policy TEXT NOT NULL,
  goal TEXT NOT NULL,
  current_step TEXT,
  blocked_task_id TEXT,
  blocked_summary TEXT,
  state_json TEXT,                             -- managed flow 的业务状态
  wait_json TEXT,                              -- waiting 原因
  cancel_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);

-- ~/.openclaw/tasks/runs.sqlite
CREATE TABLE task_runs (
  task_id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,                       -- subagent | acp | cli | cron
  owner_key TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  child_session_key TEXT,                      -- 关键！step 的 session key
  parent_task_id TEXT,
  agent_id TEXT,                               -- step 的 agent
  run_id TEXT,
  label TEXT,
  task TEXT NOT NULL,                          -- step 的 prompt / goal
  status TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  notify_policy TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  last_event_at INTEGER,
  parent_flow_id TEXT,                         -- 关联到 flow_runs.flow_id
  requester_session_key TEXT,
  task_kind TEXT,
  ...
);
CREATE INDEX idx_task_runs_parent_flow_id ON task_runs(parent_flow_id);
CREATE INDEX idx_task_runs_child_session_key ON task_runs(child_session_key);
```

**存量**（实测）：
- `flow_runs`: 26 succeeded + 3 failed，全是 `task_mirrored` 模式，owner 全是 `agent:main:orch-8-xxx`
- `task_runs`: 当前 2 cli running

**可利用性**：我们**可以**只读这两个 sqlite 作为 mission resume 的参考数据源。`better-sqlite3` 已经在 sdks/local 用过（daemon indexer）。

---

## 🎯 关键判断：原方案 A 被证伪，需要方案 A'

原 prompt 的方案 A：**"重写 mission-runner.ts 用 tasks_flow_spawn / flows.*"**

→ **不可行**，因为：
1. `tasks_flow_spawn` WS RPC **不存在**
2. `BoundTaskFlowRuntime` API **只对 OpenClaw 插件内部开放**
3. Electron main process **不是** OpenClaw 插件，拿不到 `PluginRuntimeTaskFlow`
4. 要走 TaskFlow，我们有**两条**新路径：

### 方案 A'（orchestrator agent · 07-DECISION 里的"方案 C"）

结构：
```
MissionRunner.createMission(goal)
  ↓
ws.chatSend("orchestrator", enrichedPrompt)   // 一次调用
  ↓
orchestrator agent 自己用 sessions_spawn 派发 subagents
  ↓
每个 sessions_spawn 自动 upsert flow_runs + task_runs
  ↓
MissionRunner 旁路只读：
  - 订阅 orchestrator session 拿规划/汇总 delta
  - 每 2s 轮询 SELECT * FROM task_runs WHERE parent_flow_id=?
  - 对新出现的 child_session_key 订阅拿 step delta
  - 从 flow_runs.status 判断整体 done/failed/waiting
  ↓
Resume = 
  - 读 flow_runs WHERE status IN ('queued','running','waiting','blocked')
  - orchestrator session 还活着 → resubscribe
  - 挂了 → agent.chatHistory 拿上下文 + 一句 prompt 让 orchestrator 继续
```

**收益**：
- TaskFlow durable 数据在 SQLite 里（Gateway 重启数据不丢）
- 不需要自己管 mission.json schema（流水账）
- 我们代码量减少 ~60%（sweep / hydrate / idle timer / retry 都可以删）

**风险（07-DECISION 当初拒绝它的理由仍然成立）**：
- orchestrator agent 的 planning 质量**不可控**（可能 hallucinate 子任务 / 跳过 routing rules）
- 我们失去"发给 designer 的就必须是 designer"的**强约束**
- subtask delta 分散在多个 session，UI 要**并发订阅** N 个 WS stream（比现在复杂）
- 新工作量：agent identity 文件 + routing SOUL.md + 并发订阅层 + sqlite 读层 → **~1.5 天**
- `sdks/openclaw/src/` 里的 awareness-memory plugin 可能要改，因为多 session 会放大 recall 量

### 方案 B（chat.send + re-attach + retry · 保守）

- 保留现有 `ws.chatSend` 架构
- `resumeMission(id)`：`gateway.chatHistory(sessionKey)` 看末尾
  - 有 `final` → 补跑 writeArtifact + spawnNextStep
  - 没有 final → `gateway.subscribe(sessionKey)` 继续订阅
  - 订阅返 `session not found` → 该 step 降级失败，mission 进 `paused_awaiting_human`，UI banner：「Gateway 曾重启，此 mission 需你手动继续」
- network/5xx/timeout 的 step → backoff 1s/2s/4s × 3
- **明确不做**：Gateway 重启后的 session 恢复（upstream issue #62442）
- **技术债**：docs/prd/active-features.md 加 "0.4.0 · 迁 orchestrator pattern"

**收益**：5h 可完成，preview.6 可发。
**缺点**：仍然重造轮子，只是"关 AwarenessClaw 能恢复" 解决 80% 场景。

### 方案 C（推荐 · B 然后 A'）

- **preview.6** = 方案 B （5h，本周发）
- **0.4.0** = 方案 A'（下周启动，评估 orchestrator 稳定性 + 并发订阅代价）
- 两者都需要验证 subagent-registry 是否对 agent 公开了所有必要 metadata（当前 plugin 版本支持么？）

---

## 实测环境（2026-04-18 08:54）

| 项 | 状态 |
|---|---|
| OpenClaw 版本 | 2026.4.15 (041266a) |
| Gateway | LaunchAgent loaded, port 18789 |
| Awareness daemon | 自动启动成功（autoRecall=true） |
| flow_runs 存量 | 29 行（26 succeeded + 3 failed，都是 tank battle game 历史） |
| task_runs 当前 | 2 cli running（应该是 cron job） |
| vitest `mission-*` | **312 pass** ✓（handoff 说 375 是广义计数；窄匹配 312） |
| `verify:mission-all` | **4 L1 PASS** ✓ |
| E2E smoke | 未跑（需要用户确认再跑，55s，烧 token） |

---

## 🤔 4 个待决策（请用户拍板）

### 决策 1 · preview.6 立即做方案 B（5h）还是等方案 A'（~1.5 天）？

- **方案 B**：快速 ship，覆盖 "关 AwarenessClaw 重启" 80% 场景，保留技术债到 0.4.0
- **方案 A'**：慢但对齐 OpenClaw 生态，Gateway 重启也 durable（数据层），session 层仍有 upstream 限制
- **推荐 C**：B → A'，但需要你确认 0.4.0 的 breaking change 窗口
- ⚠ **注意**：原 prompt 写的"方案 A（tasks_flow_spawn 重写）"**不存在**，必须改为 A'

### 决策 2 · 如果走 A'，orchestrator agent 预设还是让用户自配？

- **预设**：我们发包时 `AwarenessClaw/packages/desktop/config/orchestrator-agent.json` 加到 `~/.openclaw/agents/`，用户不用做任何事
- **让用户配**：给模板 + 文档，用户点 "Create Orchestrator" 按钮一键创建
- **推荐预设**：和"零命令行、10 岁可用"原则一致；但要保证 agent 的 SOUL.md 写清 routing rules，避免 hallucinate agentId

### 决策 3 · mission.json 数据迁移：保留兼容读 vs 0.4.0 breaking？

- **保留兼容读**：preview.5 用户升级后还能看历史 mission；MissionHistoryList 显示"（legacy）"
- **Breaking**：0.4.0 直接用 sqlite 作为唯一 source of truth，历史 mission 丢失
- **推荐兼容读**：用户数据不能丢；新 mission 走 sqlite，老 mission.json 降级为 read-only UI 缓存

### 决策 4 · Gateway 重启后 session 丢失（upstream #62442）—— UI 怎么提示？

- **方案 a**：banner "Gateway 刚重启过，此 mission 的 step 可能需要重发"（检测方法：启动时对比 gateway uptime vs mission.startedAt）
- **方案 b**：每个 running mission 被 re-attach 失败时加红色感叹号 + "重试"按钮
- **方案 c**：静默降级，不提示
- **推荐 a+b**：banner 是全局警告，每个 step 也有本地 retry；静默 c 违反"用人话说话"原则

---

## Sources（本轮新增）

- 本地实测：`~/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/src/tasks/*.d.ts`（完整类型签名）
- SQLite schema：`~/.openclaw/flows/registry.sqlite` + `~/.openclaw/tasks/runs.sqlite`（sqlite3 `.schema`）
- CLI 实测：`openclaw tasks --help` / `openclaw tasks flow --help` / `openclaw tasks flow list --json`（29 历史 flow）
- 上一轮 Web search 结论（RESUME_DESIGN.md 末尾 12 链接）—— 仍然有效，但**"openclaw flows recover CLI"** 是误读，实际不存在
