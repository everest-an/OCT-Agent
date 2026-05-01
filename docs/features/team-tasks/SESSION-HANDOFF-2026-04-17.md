# Session Handoff · 2026-04-17

> Context window 即将满，会话交接。下一轮会话从这里接着做。

## 本轮完成（S1 Phase 2 + 3 全部落地）

**后端 8 个模块 + 189 tests 全绿，零 TS 新错误，零回归**。

| 模块 | 文件 | Tests | 说明 |
|---|---|---|---|
| Streaming POC | [electron/ipc/register-workflow-handlers.ts](../../../packages/desktop/electron/ipc/register-workflow-handlers.ts) + preload + types + [test](../../../packages/desktop/src/test/workflow-streaming-delta.test.ts) | 8 | 现有 workflow handler 加 `state=delta` 分支 + 200ms 节流 → `task:stream-delta` IPC event |
| types | [electron/mission/types.ts](../../../packages/desktop/electron/mission/types.ts) | — | Mission / MissionStep / Plan / ArtifactFrontmatter / Heartbeat / MissionErrorCode |
| file-layout | [electron/mission/file-layout.ts](../../../packages/desktop/electron/mission/file-layout.ts) + [test](../../../packages/desktop/src/test/mission-file-layout.test.ts) | 41 | 纯 fs helper · 原子写 / path traversal 防护 / 跨平台 |
| plan-schema | [electron/mission/plan-schema.ts](../../../packages/desktop/electron/mission/plan-schema.ts) + [test](../../../packages/desktop/src/test/mission-plan-schema.test.ts) | 35 | Plan JSON runtime validator · 13 forbidden fields · DAG 环检测 |
| planner-prompt | [electron/mission/planner-prompt.ts](../../../packages/desktop/electron/mission/planner-prompt.ts) + [test](../../../packages/desktop/src/test/mission-planner-prompt.test.ts) | 24 | 带闭环测试（Example 必通过 validator） |
| worker-prompt | [electron/mission/worker-prompt.ts](../../../packages/desktop/electron/mission/worker-prompt.ts) | — | 单元未独立测，由 mission-runner.test 覆盖 |
| mission-runner | [electron/mission/mission-runner.ts](../../../packages/desktop/electron/mission/mission-runner.ts) + [test](../../../packages/desktop/src/test/mission-runner.test.ts) | 22 | Orchestrator 主循环 · Planner 重试 · step 失败链 · DAG 串行 |
| perf guards | 同上 + [test](../../../packages/desktop/src/test/mission-runner-perf.test.ts) | 12 | step idle timeout · MEMORY cap · artifact cap · 2000 delta burst |
| streaming-bridge | [electron/mission/streaming-bridge.ts](../../../packages/desktop/electron/mission/streaming-bridge.ts) + [test](../../../packages/desktop/src/test/mission-streaming-bridge.test.ts) | 24 | `createGatewayAdapter(ws)` · normalize payload · 4 种 delta shape |
| awareness-bridge | [electron/mission/awareness-bridge.ts](../../../packages/desktop/electron/mission/awareness-bridge.ts) + [test](../../../packages/desktop/src/test/mission-awareness-bridge.test.ts) | 23 | recallForPlanner / recallForStep · F-053 单参数协议 · fail-safe |
| **总计** | — | **189** | |

## 关键决策（必读）

1. **方案 B 拍板**：TaskFlow + sessions_spawn + streaming（见 [07-DECISION-LOBSTER-VS-TASKFLOW.md](./07-DECISION-LOBSTER-VS-TASKFLOW.md)）
2. **Plan 是 JSON**（非 YAML），3-5 subtasks，13 forbidden fields 黑名单
3. **Streaming first-class**：Gateway `event:chat state=delta` 已打通，IPC 层已有 200ms 合批
4. **Fail-safe 优先**：awareness-bridge / idle timeout / artifact cap / memory cap 全部防止"卡死"
5. **F-053 单参数**：`awareness_recall({ query, limit, token_budget })`

## 下一轮会话要做的事（Phase 4 · UI + IPC · ~21h）

顺序 task：

| Task | 工时 | 产出 |
|---|---|---|
| **S1-T9** register-mission-handlers.ts | 3h | 组装 MissionRunner + streaming-bridge + awareness-bridge，暴露 IPC `mission:*` |
| **S1-T10** PlanPreview.tsx | 4h | planner streaming 展示 + plan 大纲 + approve/edit/cancel |
| **S1-T11** KanbanCardStream.tsx | 4h | 卡片展开实时 stdout stream |
| **S1-T12** TaskCenter.tsx | 5h | 整合 Mission Flow（input→planning→preview→running→done） |
| **S1-T13** MissionComposer.tsx | 3h | Dashboard 顶部大目标输入框 |
| **S1-T14** i18n + 文案 | 2h | en / zh |

之后 Phase 5 测试（20h）+ Phase 6 收尾（5h）。

## 关键上下文

- **7 个文档**：[00-PROBLEM](./00-PROBLEM.md) / [01-DESIGN](./01-DESIGN.md) / [02-FILE-LAYOUT](./02-FILE-LAYOUT.md) / [03-ACCEPTANCE](./03-ACCEPTANCE.md) / [04-STAGES](./04-STAGES.md) / [05-TASKS](./05-TASKS.md) / [06-RESEARCH](./06-RESEARCH.md) / [07-DECISION](./07-DECISION-LOBSTER-VS-TASKFLOW.md)
- **现有基建（S1-T9 IPC handlers 要复用）**：
  - `electron/gateway-ws.ts` 提供 GatewayClient（extends EventEmitter，有 `chatSend/chatAbort/on/off`）
  - `electron/memory-client.ts` 提供 `callMcp(tool, args)`
  - `electron/ipc/register-workflow-handlers.ts` 里有现有 `mission:start` handler 可作为**对照**（旧版本，用 orchestrator prompt）—— S1-T9 会并存或替换，需讨论
- **预存在 TS 错误**（不是我引入的）：`register-workflow-handlers.ts:993-994` ws.off possibly null × 2。用 git stash 验证过是 baseline 遗留
- **预存在测试失败**（不是我引入的，工作区有别人未提交改动）：`memory-protocol / register-chat / register-agent / self-improvement` 共 7 失败。Phase 4 开工前可以先忽略

## 验证命令（新会话第一步跑）

```bash
cd /Users/edwinhao/Awareness/OCT-Agent/packages/desktop

# 确认新增 8 个文件的 189 tests 仍全绿
npx vitest run \
  src/test/workflow-streaming-delta.test.ts \
  src/test/mission-file-layout.test.ts \
  src/test/mission-plan-schema.test.ts \
  src/test/mission-planner-prompt.test.ts \
  src/test/mission-runner.test.ts \
  src/test/mission-runner-perf.test.ts \
  src/test/mission-streaming-bridge.test.ts \
  src/test/mission-awareness-bridge.test.ts

# 预期：8 files · 189 tests · 全 pass · <10s
```

## 未提交改动

所有代码和文档都在 working tree 里，**未 commit**。用户应该在下一轮会话开始前决定：
- 先 commit 一版（锁定进度） — 推荐
- 还是 Phase 4 做完再一次性 commit

## 用户硬性要求（记住！）

1. **充分测试**（L1-L5 五层，已做 L2 + 部分 L3） — 剩余 L1 guards / L3 streaming chaos / L4 Playwright E2E / L5 Stryker 在 Phase 5
2. **小白用户友好** — Dashboard 顶部大输入框 → plan preview → 一键 approve；3 按钮失败处理
3. **不造轮子** — 用 OpenClaw TaskFlow + subagents 原生能力
4. **Streaming 一等民** — 已完成后端，Phase 4 要在 UI 上真实展示
5. **不能卡死** — perf guards 已布防线（idle / caps）
