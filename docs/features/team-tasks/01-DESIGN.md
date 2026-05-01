# 01 · Design — Mission Orchestrator 架构（Lobster-first）

> **更新日期**：2026-04-17（重大更新：采纳 Lobster）
> **前置阅读**：[00-PROBLEM.md](./00-PROBLEM.md) · [06-RESEARCH.md](./06-RESEARCH.md)
> **对应实现**：Stage 1-3（S4 DAG 部分另议）

## ⚠️ 决策变更（2026-04-17 用户拍板）

> "尽量用已有的 OpenClaw Lobster + subagents 原生能力，不要重复造轮子，但要充分测试。"

**新基调**：
- Lobster 已经有 YAML pipeline / stdin 接力 / resume token / approval / condition → **不自己写 orchestrator**
- OpenClaw sub-agents 已经有 `maxChildrenPerAgent=5` / lifecycle 事件 / model 分层 → **不自己写 spawn 池**
- 我们专注写：**Planner（目标 → Lobster YAML）+ Awareness 注入 + 小白 UI + 充分测试**

本文件原来的"自建 orchestrator"设计已**作废**，保留的是命名 + prompt + UI 部分。下面是新设计。

## 一、新架构字符图（Lobster-first）

```
用户在 Dashboard 顶部输入框："帮我做一个博客系统，用 Next.js"
  │
  ▼
┌─────────── OCT-Agent (我们写的薄层) ───────────┐
│                                                    │
│  ① Planner（我们写的 Prompt）                      │
│    • 挑一个 agent（用户可选或自动）                │
│    • Planner 收到：                                │
│        用户目标 + available_agents + Awareness     │
│        recall（"过往经验"）                        │
│    • Planner 输出：**Lobster YAML**（不是我们的    │
│      自定义 JSON）                                 │
│    • 落盘：~/.awarenessclaw/missions/<id>/plan.yaml│
│                                                    │
│  ② Plan Preview（UI 层）                           │
│    • 用户看 plan 大纲，[Approve] / [Edit] / [X]   │
│    • Approve 后进入 ③                              │
│                                                    │
│  ③ 调 Lobster 执行（OpenClaw 原生能力）            │
│    exec: `openclaw lobster run plan.yaml`          │
│    or:   `openclaw tools lobster --yaml ...`       │
│    （具体命令在 S1-T0 verify 后定）               │
└────────────────────────────────────────────────────┘
  │                                │
  │ 调用                            │ 订阅事件流
  ▼                                ▼
┌─────────── OpenClaw (已有能力，不自己写) ───────────┐
│                                                     │
│  Lobster Engine：                                   │
│    • 按 YAML 顺序 / DAG 执行 steps                 │
│    • stdin: $prev.stdout 原生接力                   │
│    • 失败 → 返回 resume token                       │
│    • approval: required → pause                     │
│    • condition: $x.approved → 分支                  │
│                                                     │
│  每个 step 的 command 是：                          │
│    openclaw agent --agent <X> --model <Y>          │
│      --session-id <$mission_id-T{n}>               │
│      -m "{step prompt}"                            │
│  ↓                                                  │
│  Sub-agent session（agents.defaults.subagents.model│
│    决定模型，默认比主 agent 便宜）                 │
└─────────────────────────────────────────────────────┘
  │
  │ 每个 step 完成
  ▼
┌─────────── OCT-Agent 钩子（我们写） ───────────┐
│                                                    │
│  ④ Lobster pre-step / post-step hook（如支持）     │
│    pre-step: awareness_recall → 注入到 prompt      │
│    post-step: awareness_record → 保存经验          │
│                                                    │
│  ⑤ UI 层订阅 Lobster 事件流                        │
│    step.started / step.progress / step.ended       │
│    → 更新 Kanban 卡片状态                          │
│    → 把 stdout 写到 artifacts/T{n}.md（若 Lobster │
│      没原生 artifact 概念）                        │
└────────────────────────────────────────────────────┘
```

## 一·补 · 分工边界（谁写什么）

| 组件 | 写 / 用 | 位置 | 大小 |
|---|---|---|---|
| **Lobster 执行引擎** | 复用 OpenClaw 已有 | `openclaw lobster` 命令 | - |
| **Sub-agent spawn / lifecycle** | 复用 OpenClaw 已有 | `openclaw agent` CLI / Gateway WS | - |
| **Planner prompt** | 我们写 | `electron/mission/planner-prompt.ts` | ~50 行 |
| **YAML schema validator** | 我们写（防 Planner 胡写） | `electron/mission/yaml-validator.ts` | ~80 行 |
| **Lobster runner wrapper** | 我们写（启 Lobster + 事件订阅） | `electron/mission/lobster-runner.ts` | ~120 行 |
| **Awareness 注入** | 我们写（pre/post hook） | `electron/mission/awareness-bridge.ts` | ~100 行 |
| **Mission 文件管理** | 我们写（`missions/<id>/` 目录） | `electron/mission/file-layout.ts` | ~80 行 |
| **IPC handlers** | 我们写 | `electron/ipc/register-mission-handlers.ts` | ~100 行 |
| **Plan Preview UI** | 我们写 | `src/components/mission/PlanPreview.tsx` | ~150 行 |
| **Kanban 状态订阅** | 我们改现有 | `src/pages/TaskCenter.tsx` | +~80 行 |

**总新增代码量**：~700 行 TypeScript（比原设计省了 100+ 行），**但测试要多写**（Lobster 集成接触面要全覆盖）。

## 二、组件分工（旧版，已被 "一·补" 章节替代）

> ⚠️ 本节保留作对照。新分工见"一·补 · 分工边界"。核心变化：
> - ❌ 不写自己的 `orchestrator.ts` / `context-builder.ts` / `artifacts.ts`（大部分由 Lobster 提供）
> - ✅ 改为 `lobster-runner.ts`（wrapper）+ `yaml-validator.ts`（schema 守卫）+ `awareness-bridge.ts`

## 三、关键决策 + 理由（Lobster-first 重写版）

### D0（最新）· 用 Lobster 作为执行引擎，不自己写 orchestrator

**选择**：Planner 输出 Lobster YAML；执行由 `openclaw lobster run` 完成；OCT-Agent 只做薄层 wrapper。

**理由**：
- Lobster 已经有：`stdin: $prev.stdout` 接力 / resume token / approval / condition / step pause
- OpenClaw sub-agents 已经有：`maxChildrenPerAgent=5` / lifecycle 事件 / model 分层
- 自己重写等于和 OpenClaw 升级永远在追赶
- 规则："套壳不复刻，不重复造轮子"——本项目 CLAUDE.md 核心原则

**代价**：
- 被 Lobster 的语义束缚（不能轻易加自定义字段）
- 需要 S1-T0 验证 Lobster 几个关键能力（事件流订阅 / hook 机制 / resume 持久化位置）

**Contingency**：如果 S1-T0 发现 Lobster 某些能力缺失且 OpenClaw 短期不会加，**我们向 OpenClaw 贡献 PR**（已有先例：dev.to 文章 "contributed a missing piece to Lobster"），而不是自己 fork 写替代品。

### D1（保留）· Planner 用"任意 agent + role prompt"，不强制单独 planner agent

见旧版理由，没变化。

**Planner 输出格式变更**：原本是我们自定义 JSON，**现在改为 Lobster YAML**（schema 见 [06-RESEARCH.md](./06-RESEARCH.md) §1.2）。

### D2（保留 + 扩展）· Artifact 用 markdown 文件

**新增规则**：
- Lobster 每个 step 的 stdout 会默认成为下一步的 stdin
- 我们**额外**在 post-step hook 里把 stdout **格式化写入** `artifacts/T{n}.md`，加 YAML frontmatter + "Handoff to next agent" 结构化段落
- 这样 artifact 既是"人类可读产物"，又是"下个 step 的 stdin 源"

### D3（推迟）· Daemon 化

**新理解**：Lobster 本身由 OpenClaw 主 daemon 托管（Gateway / scheduled task / user session 里跑），已经不依赖 OCT-Agent 进程存活。

**具体行为待验证（S1-T0）**：
- Lobster run 一旦启动，是不是 OpenClaw Gateway 接管生命周期？
- 还是仍然随调用进程 exit 而死？

**如果 Lobster 已由 OpenClaw 托管** → S2 daemon 化工作量大幅减少，可能只需要订阅事件流的机制。

**如果仍随进程死** → S2 仍需要 daemon 化，但我们 daemon 只托管"Lobster 启动 + 订阅事件"，不托管任务逻辑。

### D4（保留）· Context 用显式 prompt 注入

Lobster 的 `stdin` 机制天然是"stdout 接力"，但：
- stdout 可能是结构化 JSON / 纯 markdown / mixed，不一定是最佳的下一步输入
- 我们在 Planner prompt 里**强制要求每个 step 输出 "Handoff block"**（见 [06-RESEARCH.md](./06-RESEARCH.md) §三·影响6）
- 下一步的 prompt 由我们在 Planner YAML 里拼好，包含前置 step 的 handoff block

### D5（保留）· 三级重试

Lobster 的 condition / resume token 可以支持这个模式：
```yaml
steps:
  - id: T3
    command: ...
    retry:
      max: 2                       # Lobster 如原生支持
      on_failure: T3-fallback      # 或者用 condition 跳转

  - id: T3-fallback
    command: openclaw agent --agent backup-developer ...
    condition: $T3.failed

  - id: T3-escalate
    command: openclaw channels send --channel main-contact ...
    condition: $T3-fallback.failed
```

**待 S1-T0 验证**：Lobster 的 retry / on_failure 语法具体是什么。

### D6（新增）· 充分测试（用户强制要求）

**用户原话**："尽量用已有的 OpenClaw ... 但要充分测试"。

**具体体现**：
- L1 Static: YAML schema 严格 validator + OpenClaw 兼容性 matrix 测试
- L2 Integration: Lobster runner wrapper 的每个分支（成功 / 失败 / approval / condition）都有测
- L3 Failure Mode: Lobster 崩溃 / OpenClaw CLI 不可用 / YAML 非法 / stdout 丢失等 8+ 种失败场景
- L4 User Journey E2E: 零 mock 跑真 Lobster + 真 OpenClaw subagent
- L5 Mutation: 至少对 `planner-prompt.ts` / `yaml-validator.ts` / `awareness-bridge.ts` 跑 Stryker

详见 [03-ACCEPTANCE.md](./03-ACCEPTANCE.md)。

## 四、生命周期状态机

```
mission.status:
  planning → running → done
     │          │   └─> failed
     │          └─> paused (用户手动)
     └─> failed (planner 出错)

step.status:
  waiting → running → done
     │          │   └─> failed (3 次后) → escalated (S3+)
     │          └─> retrying
     └─> skipped (用户手动)
```

**transition guard**（S1 开始就做）：
- `waiting → running`：必须 `depends_on` 全部 `done`
- `running → done`：必须 `artifacts/T{n}.md` 文件存在且非空
- `failed → waiting`：必须显式 "retry" 动作，不允许直接拖回
- `done → waiting`：禁止（已完成不允许重置）

## 五、Prompt 模板

### 5.1 Planner Prompt（新版 · 输出 Lobster YAML）

```
<Role>
You are the Mission Planner. Break down the user's goal into 3-5 ordered
subtasks that a team of AI agents will execute using the Lobster workflow
engine. You must output valid Lobster YAML.
</Role>

<UserGoal>
{goal}
</UserGoal>

<AvailableAgents>
{agents_yaml}
# Example:
# - id: main
#   name: Claw
#   role: Generalist
#   model: claude-sonnet-4-6
# - id: coder
#   name: Dev
#   role: Developer
#   model: claude-sonnet-4-6
</AvailableAgents>

<PastExperience>
{awareness_recall_result}
</PastExperience>

<Constraints>
- **3-5 subtasks** (not 3-8). More tasks = coordination overhead.
- Each subtask produces a **Handoff block** (see template below) that the
  next task reads via stdin.
- Sub-agents should use cheaper models (Haiku) unless the task truly needs
  stronger reasoning (plan / review).
- Use `stdin: $prev_task_id.stdout` to pass context. Use `depends_on` only
  for non-linear dependencies.
</Constraints>

<Output>
Output ONLY valid Lobster YAML. No prose outside the YAML.

name: <short-slug-of-goal>
description: <one-line summary>
args: {}

steps:
  - id: T1
    label: "Initialize Next.js project"
    role: Developer
    agent: coder
    model: claude-haiku-4-5-20251001
    command: |
      openclaw agent --agent coder --model claude-haiku-4-5-20251001 \
        --session-id $MISSION_ID-T1 \
        -m 'Read mission memory from ~/.awarenessclaw/missions/$MISSION_ID/MEMORY.md.
            Your task: Initialize a Next.js 14 project with TypeScript + Tailwind.
            Deliverable: At the end, output a markdown document with sections:
            ## What I did
            ## Key files
            ## Handoff to next agent
            - Decisions made
            - Files / paths
            - Known gotchas
            - Next recommended action'

  - id: T2
    label: "Implement login with NextAuth"
    role: Developer
    agent: coder
    model: claude-sonnet-4-6
    stdin: $T1.stdout
    depends_on: [T1]
    command: |
      openclaw agent --agent coder --model claude-sonnet-4-6 \
        --session-id $MISSION_ID-T2 \
        -m "Read the handoff block from stdin (previous step's output).
            Your task: Implement login page with NextAuth.
            Output in the same deliverable format as T1."
</Output>
```

**Planner 输出后的校验**（我们写的 `yaml-validator.ts`）：
1. YAML syntax 合法
2. steps 数量 3-5
3. 所有 `agent` 引用在 AvailableAgents 里
4. 所有 `depends_on` 引用存在的 step id
5. 无环（topological sort 能通过）
6. 所有 `command` 以 `openclaw agent` 开头（防 Planner 塞危险命令）
7. 所有 `model` 在用户 openclaw.json 配过的 model 白名单里

校验失败 → 重试 Planner 一次，带校验错误作为 retry context；仍失败 → mission.status = failed，提示用户换更强的 Planner 模型。

### 5.2 Worker Prompt（每个 step 的 prompt）

```
<MissionGoal>
{goal}
</MissionGoal>

<YourRole>
{step.role}  # e.g. "Developer"
</YourRole>

<PreviousArtifacts>
# Concatenation of depends_on steps' artifacts/T{n}.md contents
--- T1: Initialize Next.js project ---
{T1 content}

--- T2: Implement login page ---
{T2 content}
</PreviousArtifacts>

<SharedMemory>
# Current contents of MEMORY.md — updated by every step
{MEMORY.md content}
</SharedMemory>

<PastExperience>
{awareness_recall_for_this_step}
</PastExperience>

<YourTask>
{step.title}

Deliverable: {step.deliverable}

When you finish, the deliverable markdown will be saved to
artifacts/{step.id}-<slug>.md. Write it in a structure that the next agent
can read and understand what you did, including:
  - Key files you created or modified
  - Key decisions you made
  - Anything the next agent needs to know
</YourTask>

<Tools>
You have access to OpenClaw full tool set:
  - exec (shell commands)
  - read / write (files)
  - search (workspace)
  - skills (any installed skill)
When done, output the deliverable as your final message.
</Tools>
```

### 5.3 Retry Prompt（第 2 次重试）

在 Worker Prompt 基础上追加：

```
<RetryContext>
Your previous attempt failed with:
{last_error_summary}

Stdout tail:
{last_200_lines}

Please analyze the failure and try a different approach. Do not repeat the
same command / path that failed.
</RetryContext>
```

## 六、错误分类与重试策略

### 错误分类（structured error code）

| Code | 含义 | 典型现象 | 是否可重试 |
|---|---|---|---|
| `network_error` | 网络断 / API 超时 | fetch timeout, ECONNREFUSED | 可（退避） |
| `agent_crash` | OpenClaw 进程 exit != 0 | spawn error, segfault | 可（1次） |
| `permission_denied` | 权限 / API key 无效 | 401, EACCES, sudo required | **不可**（直接升级人类） |
| `tool_rejected` | OpenClaw 拒绝工具调用 | `tools.denied` 命中 | 不可 |
| `timeout` | idle > step.timeout | 15min / 60min 无输出 | 可（调长） |
| `context_overflow` | prompt 超模型限制 | 413, context length | 可（触发压缩） |
| `unknown` | 其他 | — | 可（1次） |

### 重试流程

```
第 1 次失败
  │
  ├─ permission_denied / tool_rejected → 直接跳 step 3
  │
  ├─ 可重试错误 → 第 2 次：同 agent + retry prompt + 错误上下文
  │
  └─ 继续失败 → 第 3 次：换一个同 role 的 agent（如没有则跳）
       │
       └─ 仍失败 → step.status = 'failed', 触发 escalation（S3+）
```

### Escalation（S3+）

- 找到 mission 绑定的主要 channel（feishu / telegram / wechat / ...）
- 通过 OpenClaw `channels send` 发送：
  ```
  🚨 Mission "<goal>" 需要你介入
  Step T3 (<title>) 失败 3 次
  最后错误：{error_code} — {short_msg}
  点击查看：{app_deeplink}/missions/<id>
  ```
- mission.status → `paused_awaiting_human`

## 七、Awareness Memory 集成点

| 时机 | 操作 | 作用 |
|---|---|---|
| **Planner 启动前** | `awareness_recall(goal, limit=5)` | 让规划知道用户过去做过什么 |
| **Worker 启动前** | `awareness_recall(step.title + role, limit=3)` | 让执行 agent 复用经验 |
| **Step done 后** | `awareness_record(step.deliverable_summary, category="problem_solution")` | 保存经验供下次用 |
| **Mission done 后** | `awareness_record(goal + plan_summary, category="workflow")` | 保存整体经验 |
| **Mission failed 后** | `awareness_record(goal + error + what_tried, category="pitfall")` | 保存教训 |

## 八、小白用户 UX 路径（加强 · 2026-04-17）

### 8.1 设计原则

（出自 [06-RESEARCH.md](./06-RESEARCH.md) §四·业界共识 + 用户 2026-04-17 强调 streaming）

1. **一个大目标输入框**：不选 template / 不填 name / 不选 agent，粘贴一段话就开跑
2. **默认值一路到底**：所有选项有合理默认，"Approve" 按钮永远在右下角
3. **不露技术细节**：不提 run id / session key / lifecycle event / JSON schema
4. **失败只给 3 个按钮**：Retry / Skip / Take over，不要下拉菜单
5. **plan preview 可编辑**：高级用户能改 JSON，小白直接点 Approve
6. **🔥 Streaming 必须 first-class（用户硬要求）**：
   - Planner 生成 plan 时 → **tokens 逐字出现**（像 ChatGPT 思考输出）
   - Worker 执行 step 时 → 卡片可展开看**实时 stdout stream**
   - tool 调用 → inline chip 即时显示（"📖 reading file..."）
   - 零等待感：首个 token 必须 3s 内可见
   - 背景原因：OCT-Agent 的普通 chat 已经有 streaming（[CLAUDE.md](../../../CLAUDE.md) 强调）。mission 没有 streaming 会显得比 chat 还慢，体验崩

### 8.1·补 · Streaming 实现约定

| 层 | 职责 | 节奏 |
|---|---|---|
| **Gateway WS** | OpenClaw 原生推送 delta | 每 token 一帧（可能几十 Hz） |
| **streaming-bridge.ts** | 订阅 WS → 按 200ms 合批 → IPC 推送 | ≤ 5 次/秒 |
| **React 渲染** | 追加到 `<pre>` 或 Markdown 组件 | 60fps 不卡 |
| **自动滚动** | 新 token 自动滚到底 | 用户手动滚 = 暂停自动 |

**事件形状**（对应 `register-mission-handlers.ts`）：

```typescript
// 用户可见事件
type MissionEvent =
  | { type: 'planner-delta'; missionId: string; chunk: string }
  | { type: 'plan-ready'; missionId: string; plan: Plan }
  | { type: 'step-started'; missionId: string; stepId: string }
  | { type: 'step-delta'; missionId: string; stepId: string; chunk: string }
  | { type: 'step-tool'; missionId: string; stepId: string; tool: string; state: 'start'|'end'; name: string }
  | { type: 'step-ended'; missionId: string; stepId: string; artifact: string }
  | { type: 'step-failed'; missionId: string; stepId: string; errorCode: string; message: string };
```

**不要**在 IPC event 里塞结构化 JSON 数据，每个 delta 只有 chunk 字符串（前端追加即可）。

### 8.2 字符图 · 主路径（小白）

```
┌─ Dashboard 顶部（新加的一个区域）─────────────────────┐
│                                                        │
│  🦞 Tell me what you want to build...                 │
│  ┌──────────────────────────────────────────────┐     │
│  │ 做一个博客系统，用 Next.js                     │     │
│  │                                              │     │
│  └──────────────────────────────────────────────┘     │
│                                  [Cancel] [Let's go! ✨]│
└────────────────────────────────────────────────────────┘
                        ↓ 点击 Let's go!
┌─ 自动切换到 Task Center ──────────────────────────────┐
│                                                        │
│  🧠 Planning your mission... ⏳                        │
│  This takes ~10 seconds.                               │
│  Claw is thinking about how to break this down.        │
└────────────────────────────────────────────────────────┘
                        ↓ Planner 出结果
┌─ Plan Preview ─────────────────────────────────────────┐
│                                                        │
│  ✨ Here's my plan (4 steps, ~30 min):                 │
│                                                        │
│   1. 💻 Initialize Next.js project           ~5 min    │
│      by coder                                          │
│                                                        │
│   2. 💻 Implement login with NextAuth        ~10 min   │
│      by coder · depends on step 1                      │
│                                                        │
│   3. 💻 Build article CRUD                   ~10 min   │
│      by coder · depends on step 2                      │
│                                                        │
│   4. 🧪 Write E2E tests                      ~5 min    │
│      by tester · depends on step 3                     │
│                                                        │
│   💡 Models:                                           │
│      • Steps 1,3,4: Haiku (cheap)                      │
│      • Step 2 (critical auth logic): Sonnet            │
│                                                        │
│                [Edit plan] [Cancel] [Approve & Run] ✨ │
└────────────────────────────────────────────────────────┘
                        ↓ Approve & Run
┌─ Kanban Board（跑起来后）──────────────────────────────┐
│                                                        │
│  Planning   Running        Done                        │
│  ┌─────┐   ┌─────────┐    ┌────────────┐              │
│  │     │   │ 1. Init  │    │            │              │
│  │     │   │ ⏳ 2m/5m │    │            │              │
│  │     │   └─────────┘    │            │              │
│  │     │                   │            │              │
│  │     │   ┌─────────┐    │            │              │
│  │     │   │ 2. Login│    │            │              │
│  │     │   │ waiting │    │            │              │
│  │     │   └─────────┘    │            │              │
│  │     │                   │            │              │
│  └─────┘   └─────────┘    └────────────┘              │
│                                                        │
│  [View logs] [Pause mission]                           │
└────────────────────────────────────────────────────────┘
                        ↓ 全部 done
┌─ Success ──────────────────────────────────────────────┐
│                                                        │
│  🎉 Mission complete!                                  │
│  Built in 27 minutes. 4 artifacts saved.              │
│                                                        │
│  [View artifacts] [Open project folder] [New mission]  │
└────────────────────────────────────────────────────────┘
```

### 8.3 字符图 · 失败路径

```
┌─ Step 3 Failed ────────────────────────────────────────┐
│                                                        │
│  ⚠️ Step 3 (Build article CRUD) needs your attention.  │
│                                                        │
│  What happened:                                        │
│  The coder agent tried 2 different approaches but     │
│  couldn't figure out the Prisma schema relationship.  │
│                                                        │
│  Error type: Unable to determine approach              │
│  (not a network / permission issue)                    │
│                                                        │
│  What you can do:                                      │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐   │
│  │  Retry     │ │  Skip      │ │  I'll do this   │   │
│  │  (try 3rd) │ │  this step │ │  step myself    │   │
│  └────────────┘ └────────────┘ └──────────────────┘   │
│                                                        │
│  [View detailed logs]                                  │
└────────────────────────────────────────────────────────┘
```

### 8.4 Dashboard 输入框的"发送到 mission vs 普通 chat"判断

**问题**：Dashboard 本来就有一个 chat 输入框。现在加"一大目标"输入框会冲突。

**方案 A（独立区域）**：Dashboard 顶部新开一个"🎯 Mission"区域，和 chat 明显分开视觉上。输入框内置提示"Tell me what you want to build（将派发给团队自动完成）..."。

**方案 B（检测关键词）**：复用现有 chat 输入框，检测用户消息里的高层目标关键词（"做一个 / build / make / create / 帮我做 / ..."）+ 长度阈值，弹出"要作为 mission 跑吗？"的 inline 提示。

**推荐 A**，理由：
- 不破坏现有 chat 体验（老用户无感）
- 明显的入口 = 小白用户更容易找到
- 减少误判（关键词检测容易误伤普通问题）

具体 wireframe 在 S1-T1 单独文档里细化，保留 A/B test 可能。

### 8.5 决策待用户再确认

- [ ] Dashboard 上方是否真的加"Mission 输入框"？还是只在 Task Center 页面加 Start Mission？
- [ ] Plan preview 界面是否默认显示 YAML（高级用户）还是只显示人类可读版本？
- [ ] Approve 后是否立即 commit YAML 到 plan.yaml 并禁用编辑？
- [ ] 失败时 3 个按钮的具体动作（"Take over" 是什么——跳到 chat？还是自动生成一个 task）？

---

## 九、不在 01-DESIGN.md 涉及的话题

- 具体文件结构（→ [02-FILE-LAYOUT.md](./02-FILE-LAYOUT.md)）
- 验收标准（→ [03-ACCEPTANCE.md](./03-ACCEPTANCE.md)）
- 分阶段实施（→ [04-STAGES.md](./04-STAGES.md)）
- UI wireframe（Stage 1 先不动 UI，S1 done 后如需大改再出 wireframe）
