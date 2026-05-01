# 04 · Stages — 分阶段实施

> **更新日期**：2026-04-17
> **详写**：S1（即将开工）
> **Stub**：S2-S4（等 S1 完成后再细化）
> **前置阅读**：[01-DESIGN.md](./01-DESIGN.md) · [03-ACCEPTANCE.md](./03-ACCEPTANCE.md)

## 整体路线

```
S1 (3-4 天)   ┌──────── Planner + Context 接力 + 文件持久化 ────────┐
              │  demo 能看的最小版本：拆解、接力、落盘               │
              └──────────────────────────────────────────────────────┘
S2 (3 天)     ┌──────── Runner daemon 化 + Resume ───────────────────┐
              │  关 app 继续跑、重开 app 看进度                        │
              └──────────────────────────────────────────────────────┘
S3 (2 天)     ┌──────── 三级重试 + Awareness memory 注入 ────────────┐
              │  失败不放弃、复用过往经验                              │
              └──────────────────────────────────────────────────────┘
S4 (5-7 天)   ┌──────── 长任务 checkpoint + 人类介入 + 并行 ─────────┐
              │  生产级：DAG 执行、长任务断点、channel 叫人           │
              └──────────────────────────────────────────────────────┘
```

**总工期估算**：全职 2-3 周 / 兼职 4-6 周。

---

# Stage 1 · Planner + Context 接力 + 文件持久化（详写）

## 范围（In Scope）

1. 新建 Mission Orchestrator 模块（main 进程内跑）
2. Planner 阶段：调任意 agent 输出 JSON plan
3. Queue 阶段：校验 plan，生成 mission.json 的 steps[]
4. Runner 主循环：顺序执行 step（S1 不做并行）
5. Context Builder：组装 `<PreviousArtifacts> + <SharedMemory> + <PastExperience-empty> + <YourTask>` 的 prompt
6. Artifact Writer：step 完成后写 `artifacts/T{n}.md` + append `MEMORY.md`
7. 文件持久化：`mission.json` / `plan.md` / `MEMORY.md` / `artifacts/` 按 [02-FILE-LAYOUT.md](./02-FILE-LAYOUT.md) 落盘
8. UI：Task Center 显示 mission 列表 + step 状态（最小改动，不大改 Kanban）

## 不做（Out of Scope）

- ❌ Runner daemon 化（S2）
- ❌ App 关了继续跑（S2）
- ❌ 三级重试（S3）
- ❌ Awareness memory 注入（S3，**但保留接口位**：`<PastExperience>` 块 S1 时注入空字符串，S3 再填）
- ❌ 并行 step（S4）
- ❌ 人类介入通道（S4）
- ❌ Checkpoint / 长任务断点（S4）

## Exit Criteria（S1 什么时候算完）

1. ✅ [03-ACCEPTANCE.md](./03-ACCEPTANCE.md) Journey 1-5 全部通过
2. ✅ Failure 1-5 集成测试通过
3. ✅ 手动 demo：从 "Make a TODO list app with React" 目标，产出 ≥ 3 个 artifacts/T{n}.md，每个 agent 真的读到了前一个的输出
4. ✅ 本地运行 30 分钟以上无崩溃
5. ✅ `npm test` 绿，`npm run build` 绿，`electron-builder --mac` 能打包
6. ✅ [05-TASKS.md](./05-TASKS.md) 的 S1 所有 task 打 ✅
7. ✅ CHANGELOG 写"用户看到什么变化"（不是 "fix X"）

## 技术选型（S1）

| 层 | 技术 | 备注 |
|---|---|---|
| Runner 所在进程 | Electron main（单进程） | S1 简化 |
| 调 OpenClaw | 复用 `gateway-ws.ts` 的 `chatSend` | 不走 CLI fallback |
| Planner JSON 解析 | 手写 parser（支持 JSON-in-markdown） | 避免外部依赖 |
| 文件原子写 | `fs.writeFile(tmp) + fs.rename(final)` | Node 内置 |
| UI 状态同步 | 现有 `webContents.send` 事件流 | 复用 |
| 测试框架 | vitest + @testing-library + Playwright | 和项目一致 |

## 风险

| 风险 | 概率 | 缓解 |
|---|---|---|
| Planner agent 输出的 JSON 不合法 | 高 | schema 校验 + 重试 1 次 + fallback 到单 step mission |
| Context prompt 太长（历史 artifact 累积） | 中 | S1 先不压缩，超过 30K tokens 警告；S4 做 compression |
| 破坏现有 Mission UI 功能 | 中 | S1 最小改动 UI，新 Orchestrator 跑在"并行"路径上，旧 workflow runner 保留 |
| 原子写在 Windows 上 rename 失败 | 低 | 用 `fs.rename` + fallback 到 `fs.copyFile + unlink` |

## 交付物

代码：
- `packages/desktop/electron/mission/orchestrator.ts` (新, ~200 lines)
- `packages/desktop/electron/mission/context-builder.ts` (新, ~120 lines)
- `packages/desktop/electron/mission/artifacts.ts` (新, ~80 lines)
- `packages/desktop/electron/mission/plan-parser.ts` (新, ~60 lines)
- `packages/desktop/electron/mission/file-layout.ts` (新, ~100 lines)
- `packages/desktop/electron/ipc/register-mission-handlers.ts` (新, ~150 lines)
- `packages/desktop/src/pages/TaskCenter.tsx` (改, +100 -50 lines)
- `packages/desktop/src/lib/mission-store.ts` (改, +50 -10 lines)

测试：
- `packages/desktop/src/test/mission-orchestrator.test.ts` (新)
- `packages/desktop/src/test/mission-context-builder.test.ts` (新)
- `packages/desktop/src/test/mission-plan-parser.test.ts` (新)
- `packages/desktop/src/test/mission-artifacts.test.ts` (新)
- `packages/desktop/test/e2e/user-journeys/team-task-planner.spec.mjs` (新)
- `packages/desktop/test/e2e/user-journeys/team-task-context-relay.spec.mjs` (新)
- `packages/desktop/test/e2e/user-journeys/team-task-step-done.spec.mjs` (新)
- `packages/desktop/test/e2e/user-journeys/team-task-survive-restart.spec.mjs` (新)
- `packages/desktop/test/e2e/user-journeys/team-task-kanban-sync.spec.mjs` (新)

文档：
- 本目录文档更新（标 ✅ Stage 状态）
- `OCT-Agent/packages/desktop/CHANGELOG.md` 加条目
- 主仓 `Awareness/docs/prd/deployment-log.md` 加一行（如果涉及 desktop 发布）

---

# Stage 2 · Runner daemon 化 + Resume（stub）

## 范围（待细化）

- Runner 从 Electron main 抽离成独立 Node process
- PID 文件 + 抢占锁机制（见 [02-FILE-LAYOUT.md](./02-FILE-LAYOUT.md) §四）
- Electron app 关了 daemon 继续跑
- Electron app 重开 → 读 mission.json / HEARTBEAT → 显示实时进度
- HEARTBEAT 超时检测 + 自动标 interrupted

## 前置依赖

- S1 完成（已有 mission.json / HEARTBEAT.md / artifacts/）
- 评估是否复用 Awareness local daemon（`sdks/local/`）还是独立新 daemon

## Exit Criteria

- [03-ACCEPTANCE.md](./03-ACCEPTANCE.md) Journey 6-7 通过
- Failure 6-7 通过
- 升级 OCT-Agent 时 mission 不丢（daemon 先 graceful shutdown）

## 开工前要先定

- [ ] Runner daemon 是独立 npm 包还是 OCT-Agent 内嵌？
- [ ] daemon 如何升级（用户不手动操作情况下）？
- [ ] 多个 OCT-Agent app 实例（理论上单例但 macOS 可能开多个）怎么处理？

---

# Stage 3 · 三级重试 + Awareness memory 注入（stub）

## 范围（待细化）

- 错误分类：network_error / agent_crash / permission_denied / tool_rejected / timeout / context_overflow / unknown
- 重试流程：
  - 第 1 次失败 → 同 agent + retry prompt + 错误上下文
  - 第 2 次失败 → 换同 role 的 agent
  - 第 3 次失败 → mission.status = paused_awaiting_human（S4 加通知）
- Awareness memory 集成：
  - Planner 启动前 `awareness_recall`
  - Worker 启动前 `awareness_recall`
  - Step done 后 `awareness_record`
  - Mission done/failed 后 `awareness_record`

## 前置依赖

- S1 完成
- 需要 Awareness memory IPC 在 Electron 主进程可用（应已具备，`electron/memory-client.ts`）

## Exit Criteria

- [03-ACCEPTANCE.md](./03-ACCEPTANCE.md) Journey 8-9 通过

---

# Stage 4 · 长任务 checkpoint + 人类介入 + 并行（stub）

## 范围（待细化）

- Step 内 checkpoint：单个 step 跑 > 30min 时每 5min 存一个 checkpoint（step.progress 字段）
- DAG 并行执行：depends_on 不重叠的 step 可以同时 spawn
- 人类介入通道：
  - 检测 mission 绑定的 channel（feishu / telegram / wechat）
  - escalation 时走 `openclaw channels send`
  - app 显示 "Waiting for human" 状态
- Context compression：
  - prompt > 20K tokens 时，用一个 cheap agent 先做摘要
  - 摘要替换掉旧 artifact 内容（原文件归档到 `artifacts/archive/`）

## 前置依赖

- S1-S3 完成
- 用户至少配置了一个 channel（S4 只对配了 channel 的 mission 有效）

## 开工前要先定

- [ ] 并行度上限是多少？默认 3 还是 5？
- [ ] Context compression 用什么 agent 跑？小模型（Haiku）还是 utility agent？
- [ ] 人类介入的 UX 怎么设计？deep link 回 app？还是在 channel 里直接对话？

---

## 进度追踪

所有 Stage 的进度在 [README.md](./README.md) 顶部表格 + [05-TASKS.md](./05-TASKS.md) checklist。

完成一个 Stage 后：
1. README.md 表格对应行状态改 ✅
2. CHANGELOG.md 加条目
3. 走一遍 [03-ACCEPTANCE.md](./03-ACCEPTANCE.md) 对应 Journey 列表
4. commit message 带 Stage 编号（`feat(mission): S1 complete — Planner + context relay`）
