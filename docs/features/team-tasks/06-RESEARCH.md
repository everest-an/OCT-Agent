# 06 · Research — OpenClaw 多任务机制 + 业界最佳实践

> **更新日期**：2026-04-17
> **调研方法**：Web Search + OpenClaw 官方文档 + 业界 2026 AI agent 框架对比
> **结论影响**：重大更新 [01-DESIGN.md](./01-DESIGN.md) 的 D1-D5 关键决策

---

## 一、OpenClaw 原生多任务能力（必读，我们的基础）

### 1.1 Sub-Agents（`/subagents spawn`）

**来源**：[docs.openclaw.ai/tools/subagents](https://docs.openclaw.ai/tools/subagents)

**核心机制**：
- Sub-agent 是从现有 agent run 派生的**后台任务**，有独立 session
- 完成时**主动通知**原 chat channel，不阻塞 parent
- spawn 命令**立即返回 run id**（非阻塞），结果异步回流
- 可通过 **`sessions_spawn` tool** 或 **`/subagents spawn` 命令**

**关键配置**：
| 配置项 | 默认值 | 含义 |
|---|---|---|
| `maxChildrenPerAgent` | 5 | 每个 agent session 最多 5 个活跃子 agent |
| `agents.defaults.subagents.model` | (继承主) | sub-agent 默认模型（可配更便宜的 Haiku） |
| 每 agent 覆盖 | — | 单个 agent 可 override sub-agent 配置 |

**"可配置嵌套深度"**：orchestrator → planner → worker → tester 的嵌套链条 OpenClaw 原生支持。

### 1.2 Lobster —— OpenClaw 原生工作流引擎（关键发现！）

**来源**：[docs.openclaw.ai/tools/lobster](https://docs.openclaw.ai/tools/lobster) · [github.com/openclaw/lobster](https://github.com/openclaw/lobster)

**官方定位**（原文）：
> "Lobster is a predictable, AI-friendly pipeline spec with first-class approvals and resume tokens."

**这意味着我们要自己写的东西大部分已经存在！**

**Lobster YAML 核心能力**：

```yaml
name: blog-system
args:
  framework:
    default: "nextjs"
  database:
    default: "postgres"

steps:
  - id: plan
    command: openclaw agent -m "Plan the project structure"

  - id: scaffold
    command: openclaw agent --agent coder -m "Initialize Next.js project"
    stdin: $plan.stdout              # ← 原生的 stdout 接力！

  - id: login
    command: openclaw agent --agent coder -m "Implement login"
    stdin: $scaffold.stdout

  - id: approve-deploy
    command: echo "Ready to deploy?"
    approval: required               # ← 原生的 human-in-the-loop！

  - id: deploy
    command: pnpm deploy
    condition: $approve-deploy.approved
```

**已具备的能力**：

| 我们想要的 | Lobster 原生支持 | 说明 |
|---|---|---|
| Step 间 context 接力 | ✅ `stdin: $prev_step.stdout` | 这是我们 S1 的核心诉求之一 |
| 失败恢复 / resume | ✅ halted 时返回 resume token | **S2 的核心诉求之一** |
| 人类 approval | ✅ `approval: required` | **S4 的核心诉求** |
| 条件分支 | ✅ `condition: $x.approved` | S4 功能 |
| 工作流即数据 | ✅ YAML/JSON 可 log / diff / replay | 天然可持久化 |
| 多 agent 调用 | ✅ `command: openclaw agent --agent X` | 复用 agents 配置 |

**ClawFlows**：OpenClaw 还有个 AI 辅助生成 Lobster YAML 的工具（plain English → YAML），某种程度上**就是我们的 Planner**。

### 1.3 Multi-Agent Workflow 官方模式

**来源**：[clawdocs.org/guides/multi-agent](https://clawdocs.org/guides/multi-agent) · [openclawmcp.com/blog/openclaw-multi-agent-mode](https://openclawmcp.com/blog/openclaw-multi-agent-mode)

OpenClaw 官方推崇的多 agent 模式：

1. **Main agent 做 orchestrator**：spawn 多个 sub-agent 并行（research / long task / slow tool）
2. **Sub-agent 完全隔离**：自己的 context + session + token，避免主 agent context 污染
3. **Cost 分层**：main 用 Opus（决策）、sub-agents 用 Haiku（执行）
4. **可嵌套**：orchestrator → planner → worker 这类多层结构支持

---

## 二、业界 2026 AI Agent 编排最佳实践

### 2.1 Claude Code Subagents / Agent Teams 模式

**来源**：[code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents) · [ClaudeLog - task-agent-tools](https://claudelog.com/mechanics/task-agent-tools/) · [PubNub - Claude Code subagents best practices](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/)

**两种模式的区分**：

| 模式 | 何时用 | 特征 |
|---|---|---|
| **Subagents（顺序）** | worker 之间不需要沟通 | 父 agent 串联，各自独立 context，返回结果由父 agent 接力 |
| **Agent Teams** | 需要互相质疑、共享发现、协同 | 类似真人团队，可以中途对话 |

**Task decomposition 好坏标准**（直接引用）：
> **好的拆解**：non-overlapping file sets / clear interfaces / independent testing
> **坏的拆解**：overlapping files / interdependencies / sequential coupling that can't parallelize

**Role-based decomposition 是主流**：PM → Architect → Implementer → QA

**关键数字**：
- **3-5 个 sub-agent 是最佳数量**（超过协调开销 > 产出）
- **每个 teammate 5-6 tasks**（避免单人负担过重）
- **每个 agent own 不同文件**（避免 merge conflict）

### 2.2 其他框架对比

**来源**：[gurusup.com - Best Multi-Agent Frameworks 2026](https://gurusup.com/blog/best-multi-agent-frameworks-2026) · [KDnuggets - Top 7 orchestration frameworks](https://www.kdnuggets.com/top-7-ai-agent-orchestration-frameworks) · [chanl.ai - Multi-agent patterns](https://www.chanl.ai/blog/multi-agent-orchestration-patterns-production-2026)

| 框架 | 核心思路 | 我们能借鉴 |
|---|---|---|
| **LangGraph** | Graph + checkpointing + time travel | 状态机 + resume 模式 |
| **CrewAI** | Role-playing + crew 协作 | role 驱动的 subtask 设计 |
| **Microsoft Agent Framework** | Sequential / concurrent / handoff / group chat / Magentic-One 五种模式 | 模式选择框架 |
| **OpenAI Agents SDK** | Handoff pattern（relay race） | 显式 baton passing |
| **Google ADK** | State 自动持久化 | 持久化 by default |
| **Anthropic Agent SDK** | Claude Code subagents + Agent Teams | 我们应直接跟进（它是 Claude 家族的标准） |

### 2.3 Long-Running Autonomous Workflow（直接对应我们的诉求）

**来源**：[zylos.ai - Long-Running AI Agents 2026](https://zylos.ai/research/2026-01-16-long-running-ai-agents) · [Dave Patten - State of AI Coding Agents 2026](https://medium.com/@dave-patten/the-state-of-ai-coding-agents-2026-from-pair-programming-to-autonomous-ai-teams-b11f2b39232a)

**关键事实**：
- **AI 任务时长每 7 个月翻倍**：2024 年 15 分钟 → 2026 年 2 小时 → 2026 年底预测 8 小时
- **Execution loop** 替代 "single prompt"：agent 在一个循环里持续干活
- **Memory 是必须的**：任何 agent 都不能"从零开始"
- **State management 2026 标配**：checkpoint / resume / human-in-the-loop 默认支持

**架构共识**：
1. Task decomposition 外置（planner）
2. Worker 无状态（context 从外部注入）
3. 状态 checkpoint 到持久化存储（文件 / DB / vector store）
4. Resume token 机制
5. 人类介入 channel

---

## 三、对我们 S1 设计的直接影响（关键！）

### 影响 1 · **是否用 Lobster 作为执行引擎**（建议转向）

**原设计**：自己写 `orchestrator.ts` 跑主循环 + spawn + 监听 lifecycle。

**调研后建议**：
- **让 Planner 输出 Lobster YAML**（而不是我们自己定义的 JSON）
- **让 Lobster 执行 YAML**（resume token / approval / stdin 接力已经有）
- **我们只写**：
  - Planner prompt（goal → Lobster YAML）
  - YAML 校验器（防 Planner 胡写）
  - UI 层（把 Lobster 执行结果展示为 Kanban）
  - Awareness memory 注入（S3）

**代码量对比**：
- 自己写：~800 行 TypeScript（orchestrator + context-builder + artifacts + file-layout）
- 用 Lobster：~200 行 TypeScript（Planner prompt + YAML 校验 + UI 绑定）

**需要验证**：
- [ ] Lobster YAML 能不能让 sub-step 在 sub-agent session 里跑（而不是命令行）
- [ ] Lobster resume token 是持久化到哪里的（文件？还是 OpenClaw session state？）
- [ ] Lobster 输出事件流（stdout / events）我们在 AwarenessClaw 前端怎么订阅

**S1-T0 的真正任务**：读完 [github.com/openclaw/lobster](https://github.com/openclaw/lobster) 源码后定：走 Lobster 还是自建。

### 影响 2 · **maxChildrenPerAgent = 5 是天花板**

我们原设计 "S1 不并行，S4 再并行" —— 但 OpenClaw 原生支持 5 个并发。所以：

**修订**：S1 可以直接支持"DAG 并行"，取决于 Lobster 是否支持（需 S1-T0 验证）。如果 Lobster 支持 → 省掉 S4 的并行工作量。

### 影响 3 · **Sub-agent 模型便宜化**

**现状**：所有 sub-agent 都跟主 agent 一个模型，贵且没必要。

**修订加进 S1**：Planner 的 prompt 里**指示每个 subtask 用什么模型**，agent spawn 时传 `--model`。典型：
- Planner agent → Opus（规划需要最强推理）
- Worker agents → Sonnet 或 Haiku（执行够用）
- Reviewer → Sonnet（需要判断质量）

### 影响 4 · **3-5 个 subtask 是 sweet spot**

我们 Planner prompt 写的是 "3-8 subtask"，业界经验是 **3-5**。

**修订**：
- Planner prompt 改为"break down into **3-5** subtasks"（默认）
- 超过 5 要求 Planner 先分 phase，每个 phase 3-5 subtask
- `maxChildrenPerAgent = 5` 给了硬边界

### 影响 5 · **Role-based decomposition 是业界标准**

我们原设计的 `role: Planner/Developer/Tester/Reviewer/...` 和 Claude Code / CrewAI 的 "PM/Architect/Implementer/QA" 是同一套心智模型。**保留，但在 Planner prompt 里显式要求 role**。

### 影响 6 · **Handoff pattern（baton passing）**

OpenAI SDK 的 **handoff pattern** 和我们的"step N 读 step N-1 的 artifact" 是一回事。业界已经把它作为公认模式。

**加强**：artifact 文件里加一个**显式的 "handoff block"**，比"For the next agent"更结构化：

```markdown
## Handoff to next agent

- [ ] **Decisions made** (don't revisit)
- [ ] **Files / paths you need to know about**
- [ ] **Known issues / gotchas**
- [ ] **Next recommended action**
```

---

## 四、对 UX 的影响（小白用户路径）

### 4.1 业界共识

看 Cursor / Windsurf / Claude Code 等主流工具：

- **一个大目标输入框**：用户粘贴一段话就开跑（不选 template / 不填 name）
- **"Plan preview" 模式**：跑 Planner 后给用户看计划，让用户"Approve" / "Edit" / "Reject"
- **执行中只显示一行进度**（"T2: Implementing login... ⏳"），详细日志折叠
- **失败时用大白话**（"Step 3 needs you to decide: retry / skip / let human take over"）

### 4.2 建议 UX 流程（加到 01-DESIGN.md）

```
[Dashboard 顶部一个输入框]
   "Tell me what you want to build..."
   [                                  ] [Let's go!]

   ↓ 用户粘贴: "做一个博客系统，Next.js"

[自动切换到 Task Center，显示 "Planning..." 10 秒]

[显示 plan preview]
   "I'll split this into 4 steps:
    1. Initialize Next.js project
    2. Implement login
    3. Build article CRUD
    4. Write E2E tests

    Estimated: 30 minutes total. Continue? [Approve] [Edit] [Cancel]"

[Approve 后开跑]
   Kanban 4 列从左到右，每个卡片显示：
     - agent 名字 + emoji
     - 当前状态（planning / running / done）
     - 预计时间 / 实际时间
     - [点开看详情]（artifact 展开）

[跑完或失败]
   成功："🎉 All done! 4 artifacts saved to ~/.awarenessclaw/missions/<id>/"
   失败："Step 3 needs attention. Here's what happened... [Retry] [Skip] [Let me handle]"
```

### 4.3 关键原则（给 S1-T1 用）

1. **一次只问一件事**：不让用户同时选 template + agent + priority
2. **默认值一路走到底**：所有选项都有合理默认，用户能"一路下一步"
3. **不露技术细节**：不提 "sub-agent session key / run id / lifecycle event"
4. **失败时给 3 个按钮**：Retry / Skip / Take over，不要下拉菜单 20 个选项
5. **plan preview 可编辑**：高级用户能改 YAML，小白就点 Approve

---

## 五、未解决的问题（S1-T0 本地验证结果，2026-04-17 更新）

| 问题 | 答案 | 影响 |
|---|---|---|
| Lobster 能否在 AwarenessClaw 内嵌运行 | **❌ 不内嵌**；Lobster 是独立 npm `@openclaw/lobster@2026.3.13`，要 `npm install -g` 装 | 装 Lobster 有失败风险，违反小白友好 |
| Lobster resume token 存在哪 | 文档说"under state dir"，但未指定路径；需要装包后才能看 | 待定 |
| Lobster 能不能看到 sub-agent 的实时事件流 | **❌ 没有**；Lobster 只在结束时返回 JSON envelope | **影响 UI 实时性** — 是 Lobster 的致命缺陷 |
| `agents.defaults.subagents.model` 具体配置路径 | ✅ 确认：`{agents: {defaults: {subagents: {model: "..."}}}}` + per-agent override | S1-T4 Planner 可以用这个配模型 |
| Lobster + Awareness memory 集成点 | **❌ Lobster 无 pre/post hook**；Awareness memory plugin 已在 OpenClaw 层面 autoRecall=true 工作 | 不需要我们显式注入（plugin 自己会做） |

## 五·补 · S1-T0 本地验证新发现（重大）

本地 `openclaw 2026.4.15` 实测还发现了三个**未在原调研中出现**的能力：

### 5·补·1 · OpenClaw 内置 TaskFlow（！）

**证据**：
```bash
$ openclaw tasks flow --help
Inspect durable TaskFlow state under tasks
Commands: cancel / list / show

$ openclaw tasks flow list --json
→ 29 个 flow，含 ownerKey: "agent:main:orch-8-qjgohb"
→ revision: 154, syncMode: "task_mirrored"
→ 真实用户 goal 字段已存在
```

**意义**：
- TaskFlow 是 OpenClaw 内置的 **durable workflow engine**
- 支持 runtime: subagent / acp / cli / cron
- status: queued / running / succeeded / failed / timed_out / cancelled / lost
- **我们可能根本不需要 Lobster！** 详见 [07-DECISION-LOBSTER-VS-TASKFLOW.md](./07-DECISION-LOBSTER-VS-TASKFLOW.md)

### 5·补·2 · OpenClaw 有 ACP（Agent Control Protocol）

**证据**：
```bash
$ openclaw acp --help
Run an ACP bridge backed by the Gateway
--session <key>  Default session key (e.g. agent:main:main)
--session-label  Default session label
```

**意义**：
- ACP 是 OpenClaw 内部的 agent 编排协议
- 提供 session 管理 / provenance 追踪 / token 认证
- TaskFlow 的 `runtime: acp` 就是走这条路

### 5·补·3 · OpenClaw 有 4 个 bundled Hooks

**证据**：
```bash
$ openclaw hooks list
✓ boot-md              Run BOOT.md on gateway startup
✓ bootstrap-extra-files  Inject additional bootstrap files
✓ command-logger       Log all command events
✓ session-memory       Save session context on /new or /reset
```

**意义**：
- **没有 pre-step / post-step hook**（不能用 hook 注入 Awareness recall）
- 但 Awareness memory plugin 已经在 OpenClaw 插件层自动注册，**autoRecall=true / autoCapture=true**，不需要我们显式触发
- 如果需要扩展 hook，要走 `openclaw plugins install` 路线（可能是 Skill 系统）

### 5·补·4 · Awareness memory plugin 已自动集成

**证据（每次 openclaw 启动的 stderr 输出）**：
```
[plugins] Awareness memory plugin registered — url=http://localhost:37800, role=builder_agent, autoRecall=true, autoCapture=true
[plugins] Awareness memory plugin initialized (local daemon)
```

**意义**：
- Awareness memory 已经是 OpenClaw 插件
- `role=builder_agent` 暗示可能按 agent role 做差异化注入
- **autoRecall=true**：agent 每次回合自动注入 memory 上下文
- **autoCapture=true**：agent 每次交互自动写入 memory
- **我们 Stage 3 的"Awareness memory 注入"工作可能**已经自动满足**

---

## 五·补·5 · 新的未解决问题（S1-T0 留给下一轮）

| 问题 | 如何验证 | 优先级 | 状态 |
|---|---|---|---|
| TaskFlow 怎么 **create**（不只是 inspect）？有没有 `tasks_flow_spawn` 工具？ | 抓真实 orchestrator 场景的 Gateway WS 事件 / 读 openclaw npm 包 dist 源码 | 高 | S1-T0 未完成 |
| TaskFlow 能接受什么 goal schema？（纯字符串？JSON？YAML？） | 读源码 | 高 | S1-T0 未完成 |
| TaskFlow 的 tasks[] 里每个 task 是 sessions_spawn 产生的，还是额外声明？ | 找 tasks 不为 0 的真实 flow 看 | 高 | S1-T0 未完成 |
| orch-* session 前缀是如何触发的？某个 tool？某个配置？ | **部分答案**：[register-workflow-handlers.ts:953](../../../packages/desktop/electron/ipc/register-workflow-handlers.ts#L953) 显示 AwarenessClaw 本地手工构造 `orch-<last8>` 作为 sessionKey 传给 `chat.send`；Gateway 不强制使用 `orch-` 前缀 | 中 | ✅ 已解 |
| Gateway `event:chat` 有 `state=delta` 逐字输出 | **✅ 真实存在**，已通过 S1-T1 POC 验证：Gateway 确实发 delta 事件，payload 形状多样但能 defensive 解析 | 高 | ✅ S1-T1 已验证 |
| `agents.defaults.subagents.maxSpawnDepth=2` 能否用于让 subagent 再 spawn | 修改 config + 手工 spawn 测试 | 中（S4 用） | S4 再说 |
| OpenClaw "autoCapture" 具体保存什么粒度？每个 agent turn？每个 subagent？ | 读 Awareness memory plugin hook 代码 | 低 | 待做 |
| 有没有 webhook / pubsub 让外部订阅 TaskFlow 状态变化 | **部分答案**：Gateway WS 原生 push 支持 `event:chat` / `event:agent`，无需额外 webhook | 中 | ✅ 已解 |

### S1-T1 POC 带来的新 insight

- **不需要 "反向工程 TaskFlow create API"**：现有 mission:start handler 已经用 `chat.send` 给 main agent 传 orchestration prompt，TaskFlow 的 flow 是**副产物自动生成**的（由 Gateway 内部管理）
- **streaming 基建已经 80% 在**：Gateway emit delta + listener 订阅 `event:chat`——只需要补 `state === 'delta'` 分支即可，不需要新建独立 `streaming-bridge.ts`（原计划）
- **下一步 S1-T0 窄范围**：只需要搞清 TaskFlow 的生命周期（什么时候 auto-create、什么时候 auto-close），不用搞明白整个 API

剩余问题放到 **S1-T0b**（新窄范围 task）里处理。

---

## 六、Sources

### OpenClaw 官方

- [Sub-Agents - OpenClaw](https://docs.openclaw.ai/tools/subagents)
- [Lobster - OpenClaw](https://docs.openclaw.ai/tools/lobster)
- [Multi-Agent Workflows | OpenClaw Docs](https://clawdocs.org/guides/multi-agent/)
- [OpenClaw Sub-Agents: Background Tasks](https://open-claw.bot/docs/tools/subagents/)
- [GitHub - openclaw/lobster](https://github.com/openclaw/lobster)
- [GitHub - openclaw/openclaw](https://github.com/openclaw/openclaw)

### 业界最佳实践

- [Claude Code Sub-Agents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Agent Teams Guide](https://claudefa.st/blog/guide/agents/agent-teams)
- [Best practices for Claude Code subagents (PubNub)](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/)
- [ClaudeLog - Task Agent Tools](https://claudelog.com/mechanics/task-agent-tools/)
- [5 Claude Code Agentic Workflow Patterns (MindStudio)](https://www.mindstudio.ai/blog/claude-code-agentic-workflow-patterns)
- [Microsoft Agent Framework 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/)
- [AI Agent Orchestration Patterns - Azure](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [Best Multi-Agent Frameworks 2026 (Gurusup)](https://gurusup.com/blog/best-multi-agent-frameworks-2026)
- [Top 7 AI Agent Orchestration Frameworks (KDnuggets)](https://www.kdnuggets.com/top-7-ai-agent-orchestration-frameworks)
- [Long-Running AI Agents 2026 (Zylos Research)](https://zylos.ai/research/2026-01-16-long-running-ai-agents)
- [Multi-Agent Pattern in Production (Chanl)](https://www.chanl.ai/blog/multi-agent-orchestration-patterns-production-2026)
- [State of AI Coding Agents 2026 (Dave Patten)](https://medium.com/@dave-patten/the-state-of-ai-coding-agents-2026-from-pair-programming-to-autonomous-ai-teams-b11f2b39232a)
- [The Code Agent Orchestra (Addy Osmani)](https://addyosmani.com/blog/code-agent-orchestra/)
- [GitHub - crewAIInc/crewAI](https://github.com/crewaiinc/crewai)
- [claude-code-workflow-orchestration (GitHub)](https://github.com/barkain/claude-code-workflow-orchestration)

### OpenClaw 社区文章

- [OpenClaw multi-agent mode 2026 (OpenclawMCP)](https://openclawmcp.com/blog/openclaw-multi-agent-mode)
- [OpenClaw Multi-Agent Deployment (JIN / Medium)](https://medium.com/h7w/openclaw-multi-agent-deployment-from-single-agent-to-team-architecture-the-complete-path-353906414fca)
- [Configuring OpenClaw Multi-Agent (zhangdamao)](https://zhangdamao.com/blog/2026/04/01/configuring-openclaw-multi-agent-setup)
- [5 OpenClaw Sub-Agent Configurations (xCloud)](https://xcloud.host/openclaw-sub-agent-configurations/)
- [ClawFlows & Lobster (OpenClaw Blog)](https://openclaws.io/blog/clawflows-workflow-automation/)
- [How I Built a Deterministic Multi-Agent Dev Pipeline Inside OpenClaw (dev.to)](https://dev.to/ggondim/how-i-built-a-deterministic-multi-agent-dev-pipeline-inside-openclaw-and-contributed-a-missing-4ool)
- [Automate Workflows with OpenClaw Lobster](https://open-claw.bot/docs/tools/lobster/)
- [Building Pipelines - OpenClaw Automation (Stanza)](https://www.stanza.dev/courses/openclaw-automation/lobster-runtime/openclaw-automation-lobster-pipelines)

---

## 七、下一步

本文档的结论需要**反向更新** [01-DESIGN.md](./01-DESIGN.md) 和 [05-TASKS.md](./05-TASKS.md)：

- [ ] 01-DESIGN.md D1 章节加"Lobster vs 自建" 决策讨论（等 S1-T0 验证后拍板）
- [ ] 01-DESIGN.md 加"UX 设计" 章节（小白用户路径）
- [ ] 01-DESIGN.md 加"Handoff block" 规范
- [ ] 05-TASKS.md S1-T0 任务明确：
  - 读 Lobster 源码
  - 验证 5 个未解决问题
  - 产出 "Lobster vs 自建" 决策文档
- [ ] 05-TASKS.md 根据决策结果重排 S1 task 列表
