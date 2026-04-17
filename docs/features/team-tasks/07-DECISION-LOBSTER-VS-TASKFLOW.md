# 07 · Decision — Lobster vs TaskFlow vs Orchestrator Agent

> **更新日期**：2026-04-17（用户拍板 · 方案 B）
> **状态**：✅ **已决策 · 方案 B · TaskFlow + 薄 Planner + streaming**
> **用户拍板原话（2026-04-17）**：
> - "尽量用已有的 OpenClaw 已经有 Lobster 工作流引擎 + subagents 原生能力，我们不要重复造轮子，但要充分测试"
> - "继续吧，一定要按照我们的测试要求去测试，还要考虑用户体验的问题，比如 streaming"
>
> **Streaming 决定论**：Lobster 不支持实时事件流 → 直接否决方案 A。方案 B 天然支持 Gateway WS streaming（和现有聊天 UX 一致）。

---

## 一、三个可选方案

本地 `openclaw 2026.4.15` 实测结果让我们有 3 条可走的路。

### 方案 A · 装 Lobster npm 包

**原始设计**（见 [01-DESIGN.md](./01-DESIGN.md)）：让 Planner 输出 Lobster YAML，调 `lobster workflows.run` 执行。

**本地实测**：
- `openclaw lobster --help` → **不存在**（openclaw 没内置 lobster 子命令）
- `which lobster` → 空
- `npm list -g | grep lobster` → 无
- `npm view @openclaw/lobster version` → `2026.3.13`（有这个包，但需手动 `npm install -g @openclaw/lobster`）

**优点**：
- ✅ YAML pipeline 非常成熟（stdin pipe、approval、resume token）
- ✅ 有文档和例子

**缺点**：
- ❌ **需要额外 `npm install -g @openclaw/lobster`** → 违反"小白友好"（自动装有失败率）
- ❌ Lobster 原生**不支持实时事件流**（只有 stdout / JSON envelope）
- ❌ **无 pre/post-step hook**（Awareness 注入要在 YAML 里手工嵌入）
- ❌ **和 OpenClaw 生态是外挂**，OpenClaw Gateway / 事件流不知道 Lobster 在跑什么
- ❌ 三端兼容有风险（Lobster npm 包在 Windows 上需验证）

### 方案 B · 用 OpenClaw TaskFlow + 自建薄 Planner

**本地实测发现**：
- `openclaw tasks flow list --json` 返回 **29 个 flow**（用户真实在用）
- 现有的 `flowId` / `syncMode: "task_mirrored"` / `ownerKey: "agent:main:orch-8-qjgohb"` / `revision: 154` / `status: succeeded` / `goal: "Review and audit the tank battle game..."`
- 支持 `runtime: subagent | acp | cli | cron`
- 支持 `status: queued | running | succeeded | failed | timed_out | cancelled | lost`
- `tasks flow show / cancel / list`

**核心观察**：**TaskFlow 已经是 OpenClaw 原生的 durable workflow engine**！而且真的在跑用户的任务。

**架构**：
```
User goal
  │
  ▼
AwarenessClaw 写的 Planner（读 goal + agents 列表 + Awareness recall）
  │ 输出 JSON 任务序列（不是 YAML）
  ▼
AwarenessClaw 逐个调用 `sessions_spawn` 工具派发 subagent
  │  每个 spawn 自动登记为 TaskFlow 的一个 task
  ▼
OpenClaw Gateway + TaskFlow 管理：
  • 持久化（durable，restart-safe）
  • status 追踪
  • 事件流（Gateway WS）
  • runtime 分类（subagent）
  ▼
AwarenessClaw UI 订阅 `openclaw tasks list --watch` + Gateway WS 事件
  • Kanban 卡片状态来源 = OpenClaw task.status
  • artifact 来自 subagent 的 session transcript
```

**优点**：
- ✅ **零新依赖**（`openclaw` 已装）
- ✅ **OpenClaw Gateway 自动管 durable + restart-safe**（我们不自己管 HEARTBEAT / PID 文件）
- ✅ 事件流天然通过 Gateway WS（已有 `sessions_spawn` 集成）
- ✅ Awareness memory plugin 已自动注册（log: `[plugins] Awareness memory plugin registered — autoRecall=true, autoCapture=true`）
- ✅ 和 OpenClaw 生态原生兼容（三端一致）
- ✅ 能细粒度控制 spawn 顺序 / context 注入

**缺点**：
- ⚠️ 我们仍要写 Planner 逻辑（但很薄：~50 行）
- ⚠️ TaskFlow 的创建路径未明确（文档 `docs.openclaw.ai/tools/tasks` 404），需反向工程或问官方
- ⚠️ 没有 Lobster 那种"approval pause + resume token"的一级能力（要自己用 subagents 的 steer/send 实现）

### 方案 C · 完全交给 OpenClaw orchestrator agent

**本地实测暗示**：
- 观察到真实 TaskFlow 的 `ownerKey: "agent:main:orch-8-qjgohb"` — **有 `orch-*` 前缀**的 session
- 意味着 OpenClaw 可能有"orchestrator 模式"，用特殊 session key 启动一个会自动拆解任务的 agent
- Awareness memory plugin 日志显示 role=`builder_agent` — 暗示有 role-based 分层

**架构**：
```
User goal
  │
  ▼
AwarenessClaw 只做一件事：
  openclaw agent --agent <orchestrator-agent-id> \
    --session-id mission-<id> \
    --message "<goal>"
  │
  ▼
OpenClaw 的 orchestrator agent（由用户在 AGENTS.md 配置 SOUL）：
  • 自己读 team 的 AGENTS.md
  • 自己规划子任务
  • 自己用 sessions_spawn 派发
  • TaskFlow 自动追踪
  │
  ▼
AwarenessClaw UI 订阅：
  • openclaw tasks flow list
  • Gateway WS 事件
  • 展示为 Kanban
```

**优点**：
- ✅ **最不造轮子**：连 Planner 都是 OpenClaw agent，AwarenessClaw 只做 UI 层
- ✅ 用户能自己定制 orchestrator 的 SOUL.md（自己定义团队规则）
- ✅ 和 OpenClaw 所有能力原生集成

**缺点**：
- ❌ 需要用户创建"orchestrator agent"（违反小白友好，除非我们预装）
- ❌ 行为不可预测（agent 随机性可能导致 planning 不稳定）
- ❌ 调试困难（规划和执行都在黑盒里）

## 二、方案对比表（用户强制 streaming 维度新增）

| 维度 | A · Lobster | B · TaskFlow + 薄 Planner | C · 纯 OpenClaw agent |
|---|---|---|---|
| **Streaming（用户强制要求）** | ❌ **只返回终态 JSON** | ✅ **Gateway WS 逐字输出** | ✅ Gateway WS 逐字输出 |
| **额外依赖** | 需装 Lobster npm | 无 | 无 |
| **我们代码量** | ~700 lines | ~400 lines | ~150 lines |
| **事件流实时性** | ❌ 只有结束时 JSON | ✅ Gateway WS 实时 | ✅ Gateway WS 实时 |
| **Durable / Resume** | ✅ resume token | ✅ OpenClaw 自管 | ✅ OpenClaw 自管 |
| **Pre/Post hook** | ❌ | ⚠️ 手工 spawn 前后 | ❌ 完全黑盒 |
| **可控性** | 中（YAML 固定） | 高（我们拼 spawn） | 低（agent 自由） |
| **小白友好** | ⚠️ 装 Lobster 有失败率 | ✅ 开箱即用 | ❌ 需用户配 orchestrator |
| **跨平台（Win/Mac/Linux）** | ⚠️ Lobster 需验证 | ✅ OpenClaw 已覆盖 | ✅ OpenClaw 已覆盖 |
| **调试友好** | ✅ YAML 可读 | ✅ JSON 可 diff | ❌ 黑盒 |
| **生态对齐** | 外挂 | 原生 | 原生 |
| **测试难度** | 中 | 低 | 高（agent 不确定） |
| **上手速度（我们）** | 慢（装 Lobster + 学 API） | 中 | 快 |

**Streaming 维度的致命性**：用户的聊天 UI 已经习惯逐字输出（见 [CLAUDE.md](../../../CLAUDE.md) "streaming 必须支持" 章节）。如果 mission 执行时只能看到"转圈 + 一次性显示结果"，体验会**明显差于普通 chat**——用户会觉得"mission 比 chat 还慢"。这一条基本把 Lobster 排除在 S1-S3 之外（S4 如需特殊 approval 流程可单独启用 Lobster）。

## 三、推荐：方案 B · TaskFlow + 薄 Planner

**综合评分最高**，具体理由：

1. **零额外依赖** = 符合"小白 5 秒开箱"产品原则
2. **事件流实时** = 满足 UI Kanban 实时更新诉求
3. **OpenClaw 原生 durable** = 解决"关 app 继续跑"（S2 工作量大幅减少）
4. **可控性高** = 我们拼 spawn 调用，每步 prompt 完全可控
5. **符合用户原话**："尽量用已有的 OpenClaw ... 不要重复造轮子，但要充分测试"

### 需要的反向工程任务

文档 404，但功能存在。需要通过以下方法摸清 TaskFlow 的 API：

- [ ] 读 openclaw npm 包源码：`ls ~/.npm-global/lib/node_modules/openclaw/dist/` 找 task flow 相关实现
- [ ] 抓一次真实 orchestrator 调用的 Gateway WS 事件（`openclaw gateway --log-level debug` + tcpdump / wscat）
- [ ] 搜 GitHub：`site:github.com openclaw taskflow spawn` 找社区示例

### 用"混合方案"降低 Lobster 损失

如果 TaskFlow API 反向工程失败 / 缺某些关键能力（如 approval / resume token），我们可以**部分降级到 Lobster**：
- 核心流程走 TaskFlow + subagents
- 特定需要 approval 的场景（如 S4 人类介入）单独包一个 Lobster 调用
- 两套同时用，不冲突

## 四、方案 A / C 的备用价值

**A · Lobster** 的备用场景：
- 用户想要"pipeline as data"（YAML 可 diff / 可版本管理 / 可分享）
- 某个特殊 mission 需要复杂 approval 链
- **S4 做，不在 S1**

**C · 纯 OpenClaw agent** 的备用场景：
- 如果方案 B 反向工程失败且 TaskFlow 不开放 API
- 可以作为 S1 的**最小 POC**：一行命令 spawn 一个 orchestrator agent，看 Gateway 事件流

## 五、决策记录（✅ 2026-04-17 用户拍板）

- [x] **✅ 方案 B 拍板**：TaskFlow + 薄 Planner + Gateway WS streaming
  - 用户原话："尽量用已有的 OpenClaw ... 不要重复造轮子，但要充分测试"
  - 用户补充："要考虑用户体验的问题，比如 streaming"
- [x] **✅ 保留方案 A 作为 S4 备选**（approval 复杂场景，非 streaming 关键路径）
- [x] **✅ 方案 C 作为 baseline POC**：S1-T0 先做 10 分钟验证"给 main agent 一个 goal 它能自己拆吗"

## 六、如果拍板方案 B，Stage 1 TASK 清单的变化

原 `05-TASKS.md` 需改动：

| 原 task | 新 task |
|---|---|
| S1-T3 · 实现 yaml-validator.ts | **去掉**（用 JSON 不用 YAML） |
| S1-T4 · Planner prompt 输出 YAML | 改为**输出 JSON plan schema**（我们定义） |
| S1-T5 · Lobster runner wrapper | 改为 **TaskFlow subscriber + sessions_spawn caller** |
| 新增 | **S1-T3b · 反向工程 TaskFlow API**（读源码 + Gateway WS 抓包）· 3-4h |
| 新增 | **S1-T3c · 封装 `sessions_spawn` 调用**（走 Gateway WS tool call）· 2h |

其他 task（file-layout / awareness-bridge / IPC handlers / UI / 测试）基本不变。

工时调整：
- 节省：去掉 Lobster 安装 / YAML 处理 / 兼容性验证（~8h）
- 增加：反向工程 + spawn 调用封装（~6h）
- 净节省约 2h

## 七、Sources / 本地验证命令

```bash
# 验证 Lobster 不在 OpenClaw 内（证据）
openclaw --help | grep -i lobster  # 空
openclaw lobster --help            # "unknown command"
which lobster                      # 空
npm list -g | grep lobster         # 空

# 验证 TaskFlow 真实存在（证据）
openclaw tasks flow --help
openclaw tasks flow list --json
openclaw tasks list --runtime subagent --status running --json
openclaw tasks show <taskId> --json

# 验证 Awareness plugin 已自动注册（证据）
openclaw agents list --json 2>&1 | head -5
# stderr 显示："[plugins] Awareness memory plugin registered — url=http://localhost:37800, role=builder_agent, autoRecall=true, autoCapture=true"
```

## 八、用户决策问题

回答这 3 个问题就能拍板：

1. **确认方案 B？** 还是想先跑一下方案 C 的 POC 看效果？
2. **我们反向工程 TaskFlow 时发现缺某个能力（比如 approval），要不要也引入 Lobster 做补充？**
3. **Orchestrator agent 是否预装？** 方案 B 里我们自己拼 spawn，不需要 orchestrator agent；但用户如果愿意创建一个，我们可以给模板（加速规划）。
