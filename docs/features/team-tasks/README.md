# Team Tasks — 持续执行的多 Agent 任务引擎（方案 B · TaskFlow + Streaming）

> **Feature slug**：`f-team-tasks`
> **Status**：设计完成 ✅（S1 未开工）
> **架构基调**：**OpenClaw TaskFlow + sessions_spawn + Gateway WS Streaming**（方案 B，2026-04-17 拍板）
> **用户硬要求**：① 不造轮子 ② 充分测试（L1-L5） ③ streaming 一等民
> **负责人**：Claude Code [CC]
> **起始日期**：2026-04-17
> **相关代码**：[packages/desktop/src/pages/TaskCenter.tsx](../../../packages/desktop/src/pages/TaskCenter.tsx)、[packages/desktop/src/lib/mission-store.ts](../../../packages/desktop/src/lib/mission-store.ts)、[packages/desktop/electron/ipc/register-workflow-handlers.ts](../../../packages/desktop/electron/ipc/register-workflow-handlers.ts)、[packages/desktop/electron/gateway-ws.ts](../../../packages/desktop/electron/gateway-ws.ts)

## 一句话定义

用户给一个高层目标（"做一个博客系统"），薄 Planner 输出 JSON plan，OCT-Agent 调用 **OpenClaw Gateway 的 `sessions_spawn`** 依次派发 subagent（每个 step 一个），**订阅 Gateway WS 事件流**把 agent 的 token / tool / 完成事件实时 stream 到 Kanban UI；OpenClaw 内置 TaskFlow 自动 durable 持久化；Awareness memory plugin 已自动 autoRecall/autoCapture。

## 为什么做

当前 TaskCenter / MissionDetail 只是 **UI 脚手架**——任务跑 10 分钟以内的短 demo 还行，但：
- Agent 间没有 context 传递（step1 看不到 step0 做了什么）
- 15 分钟 idle timeout 杀死长任务
- 关 app 即死，无 resume
- 没接 Awareness memory（agent 是"一次性失忆人"）

详见 [00-PROBLEM.md](./00-PROBLEM.md)。

## 文档索引

| 文件 | 读者 | 内容 |
|---|---|---|
| [00-PROBLEM.md](./00-PROBLEM.md) | 想理解"为什么做"的人 | 现状 4 大缺口 + 用户诉求 + scope |
| [01-DESIGN.md](./01-DESIGN.md) | 动手改代码前必读 | 方案 B 架构 · Planner prompt · UX wireframe |
| [02-FILE-LAYOUT.md](./02-FILE-LAYOUT.md) | 实现持久化的人 | `~/.awarenessclaw/missions/<id>/` 结构 + schema + 原子写 |
| [03-ACCEPTANCE.md](./03-ACCEPTANCE.md) | 写 L4 E2E 的人 | Given/When/Then 验收 + failure modes + Streaming 专项 |
| [04-STAGES.md](./04-STAGES.md) | 分阶段 PM | S1-S4 scope / exit criteria / 工期 |
| [05-TASKS.md](./05-TASKS.md) | 会话接力时第一眼 | S1 engineering tasks checkbox + 进度 |
| [06-RESEARCH.md](./06-RESEARCH.md) | 动手前必读 | OpenClaw Lobster / subagents / TaskFlow / ACP / Hooks 机制 |
| [07-DECISION-LOBSTER-VS-TASKFLOW.md](./07-DECISION-LOBSTER-VS-TASKFLOW.md) | 决策记录 | 方案 B（TaskFlow）拍板理由 |
| [SESSION-HANDOFF-2026-04-17.md](./SESSION-HANDOFF-2026-04-17.md) | 🚨 **新会话从这里开始** | 已完成 189 tests + 剩余 Phase 4-6 task |

## 当前 Stage 进度（方案 B · TaskFlow + Streaming）

| Stage | 范围 | 状态 | 工期 | Exit Criteria |
|---|---|---|---|---|
| **S1 Phase 2** | 基础设施（file-layout / plan-schema / planner-prompt） | ✅ 完成 2026-04-17 | 100 tests 全绿 | — |
| **S1 Phase 3** | TaskFlow + Streaming + Awareness 集成（mission-runner + perf guards + streaming-bridge + awareness-bridge） | ✅ 完成 2026-04-17 | +89 tests = 189 total | — |
| **S1 Phase 4** | UI + IPC（register-mission-handlers / PlanPreview / KanbanCardStream / MissionComposer / useMissionFlow hook / MissionFlowShell / TaskCenter 集成 / i18n） | ✅ 完成 2026-04-17 | +130 tests = **319 total** · 0 TS 新错误 | — |
| **S1 Phase 5** | L1-L5 充分测试（verify-mission-ipc + verify-plan-schema + verify-streaming-contract L1 guards · L2 integration · L3 chaos 22 tests · L4 node:test E2E 3 specs · L5 Stryker config） | ✅ 完成 2026-04-17 | 全部交付；L4 实跑需 `npm run build` + Gateway；Stryker 实跑待首发周期 | 03-ACCEPTANCE 单元级 + contract 级通过；真机验收留 Phase 6 |
| **S1 Phase 6** | 收尾（demo / CHANGELOG / PR） | ⬜ 未开工 | ~5h | — |
| **S2** | Resume（利用 OpenClaw TaskFlow 内置 durable） | ⬜ 未开工 | 2 天 | Journey 6-7 通过 |
| **S3** | 三级重试 + 显式 Awareness recall 注入 | ⬜ 未开工 | 2 天 | Journey 8-9 通过 |
| **S4** | DAG 并行 + checkpoint + 人类介入 + 按需启 Lobster | ⬜ 未开工 | 5-7 天 | 走飞书/Telegram 叫人介入 |

## 新会话"从哪里开始"

推荐阅读顺序（~20 分钟总览）：

1. **先读 [00-PROBLEM.md](./00-PROBLEM.md)**（2min）对齐"为什么要做"
2. **读 [06-RESEARCH.md](./06-RESEARCH.md)**（5min）理解 Lobster / subagents 等可复用原语
3. **读 [01-DESIGN.md](./01-DESIGN.md)**（10min）Lobster-first 架构 + UX wireframe
4. **查看 [05-TASKS.md](./05-TASKS.md)**（3min）找第一个没打 ✅ 的 task 开工

动手前请确认：
- 对应 Stage 的 Exit Criteria（见 [04-STAGES.md](./04-STAGES.md)）
- 对应 Journey 的 Acceptance（见 [03-ACCEPTANCE.md](./03-ACCEPTANCE.md)）
- 文件结构约定（见 [02-FILE-LAYOUT.md](./02-FILE-LAYOUT.md)）

## 重大决策记录

| 日期 | 决策 | 依据 |
|---|---|---|
| 2026-04-17 | 初版：Lobster-first 架构 | 对齐 OpenClaw YAML workflow 标准 |
| 2026-04-17 | **✅ 终版：方案 B · TaskFlow + sessions_spawn**（推翻 Lobster-first） | S1-T0 本地实测：① Lobster 需额外 npm 装 ② Lobster 不支持 streaming ③ OpenClaw 内置 TaskFlow 已 production。详见 [07-DECISION-LOBSTER-VS-TASKFLOW.md](./07-DECISION-LOBSTER-VS-TASKFLOW.md) |
| 2026-04-17 | Planner 输出 **JSON**（非 YAML） | 方案 B 用 Gateway WS 调 sessions_spawn，JSON 比 YAML 更轻 |
| 2026-04-17 | **🔥 Streaming 为一等民**（用户硬要求） | Lobster 不支持 stream → 直接否决 A；Kanban 卡片可展开看 token-by-token 输出 |
| 2026-04-17 | 充分测试 L1-L5 全覆盖 | 用户硬要求；新增 5 个 Streaming 专项 L3 failure 测试（reconnect / 乱序 / 节流 / orphan tool） |
| 2026-04-17 | Dashboard 顶部加独立 Mission 输入区（方案 A UX） | 不污染 chat 体验 + 小白易找入口 |
| 2026-04-17 | subtasks 数量 3-5（非 3-8） | [06-RESEARCH.md](./06-RESEARCH.md) Claude Code 社区经验 |
| 2026-04-17 | 不装 Lobster，留作 S4 approval 场景备选 | 零新依赖 + 跨平台稳定 |

## 相关现有文档

- [../../MULTI_AGENT_COLLABORATION_GUIDE.md](../../MULTI_AGENT_COLLABORATION_GUIDE.md) — 用户层多 agent 协作说明（已有）
- [../../../TASKS.md](../../../TASKS.md) — 全仓库任务清单（本功能登记在 P2）
- [../../../CLAUDE.md](../../../CLAUDE.md) — 项目规则 + 5 层测试金字塔

## 协作约定

- Owner 标记：`[CC]` Claude Code、`[CX]` Codex、`[Human]` 人类队友
- 完成一个 task：在 `05-TASKS.md` 打 ✅ + commit hash
- 变更范围 > 1 文件：先更新 `01-DESIGN.md` / `02-FILE-LAYOUT.md`，再动代码
- 发现新缺口：在 `00-PROBLEM.md` 加一条，不要默默解决
