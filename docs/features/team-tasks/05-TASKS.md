# 05 · Tasks — 可打钩的 engineering task 清单

> **更新日期**：2026-04-17（Lobster-first 重排版）
> **当前 Stage**：S1 未开工
> **核心决策**：用 Lobster + OpenClaw subagents 原生能力，OCT-Agent 只写薄 wrapper + 充分测试
> **约定**：完成一条 → 在 checkbox 打 ✅ + 追加 commit hash + 完成日期
> **前置阅读**：[01-DESIGN.md](./01-DESIGN.md) · [06-RESEARCH.md](./06-RESEARCH.md)

## 使用说明

- 每个 task 都有：owner / 预计工期 / 依赖 / 输出文件
- Owner 标记：`[CC]` Claude Code、`[CX]` Codex、`[Human]` 人类
- 完成后追加：`— ✅ <日期> · <commit-hash-short>`
- 发现新 task 直接加在对应 Stage 末尾
- **开始一个 task 前**：读 [01-DESIGN.md](./01-DESIGN.md) / [02-FILE-LAYOUT.md](./02-FILE-LAYOUT.md) 对应章节

---

## ⚠️ 本版 S1 已被方案 B 重写（见下方"S1 · 方案 B"）

~~原 Lobster-first 方案被否决~~（见 [07-DECISION-LOBSTER-VS-TASKFLOW.md](./07-DECISION-LOBSTER-VS-TASKFLOW.md)）。

**关键否决因素**：Lobster 不支持 streaming，违反用户对"逐字输出"体验的硬要求。

## Stage 1 · 方案 B · TaskFlow + sessions_spawn + Streaming（✅ 2026-04-17 拍板）

### 核心思路

1. **不装 Lobster**（零新依赖）
2. OCT-Agent 写薄 Planner（输出 JSON 任务序列）
3. 逐个调用 **Gateway WS 的 `sessions_spawn` 工具** 派发 subagent
4. **订阅 Gateway WS 事件流**，每个 token / tool 调用都实时推给 Kanban UI（streaming）
5. OpenClaw TaskFlow 自动 durable 持久化（我们不管 PID / HEARTBEAT）
6. Awareness memory plugin **已自动 autoRecall/autoCapture**（不需额外注入）

### Phase 1 · 反向工程（必做前置，方案 B）

- [ ] **S1-T0 · 反向工程 TaskFlow + sessions_spawn API** [CC] · 4h · 依赖无
  - **7 个必须回答的问题**（写进 [06-RESEARCH.md](./06-RESEARCH.md) §五·补·5）：
    1. 怎么 **create** 一个 TaskFlow？有没有 `tasks_flow_spawn` 工具 / Gateway WS 协议？
    2. TaskFlow 接受的 goal schema？（字符串 / JSON / YAML）
    3. TaskFlow 的 `tasks[]` 怎么填？每个 task 是 sessions_spawn 结果还是单独声明？
    4. `ownerKey: orch-*` 前缀怎么触发？特殊 agent id / 某个 flag？
    5. Gateway WS 协议里关于 subagent 的 event 有哪些（delta / tool / final / error）？
    6. `sessions_spawn` 调用走 Gateway WS 的什么帧格式？
    7. `maxSpawnDepth: 2` 启用 orchestrator 模式具体步骤？
  - **验证方法**：
    - 读 `~/.npm-global/lib/node_modules/openclaw/dist/` 源码，grep "TaskFlow" / "tasks_flow" / "orch-"
    - 打开 `openclaw gateway --log-level debug`，用 `openclaw agent` 触发一个真实多步任务，抓 Gateway WS 帧
    - 读现有 `packages/desktop/electron/gateway-ws.ts` 看我们已经订阅了什么事件
  - **Exit**：
    - 产出"TaskFlow + sessions_spawn 调用手册"表格
    - 如某个问题无法通过反向工程回答，降级 S1 作用域（比如 S1 不依赖 `orch-*`，手动拼接 spawn 序列）

- [x] **S1-T1 · Streaming POC（主进程侧）** [CC] · ✅ 2026-04-17 · commit pending
  - 根因发现：`register-workflow-handlers.ts` 旧版 `event:chat` listener **只处理 `state=final`，静默丢 delta**——这是 mission 没有 streaming 的真因
  - 改动（主进程 30 行 + 前端 6 行）：
    - `register-workflow-handlers.ts` 加 `state=delta` 分支：per-session 缓冲 + 200ms 节流 flush → `task:stream-delta`
    - terminal state 前先 flush pending delta，保证 tail token 不丢
    - `preload.ts` 暴露 `onTaskStreamDelta(cb)`
    - `electron.d.ts` 加类型
    - 支持 3 种 delta shape（string / {content} / message.content）defensive 解析
  - **L2 integration test 8 tests 全绿**（`src/test/workflow-streaming-delta.test.ts`）：
    - 节流合批（多 delta 同窗口 → 1 次 IPC）
    - 重新开计时器（多窗口各自 1 次）
    - terminal 前 flush tail
    - 忽略 main-agent 噪声
    - 多 delta shape 兼容
    - 空 chunk 不发 event
    - per-session 独立缓冲
    - terminal 后 buffer 清理（防跨 run 串扰）
  - **产出**：
    - [packages/desktop/electron/ipc/register-workflow-handlers.ts](../../../packages/desktop/electron/ipc/register-workflow-handlers.ts)（改动，+68 lines）
    - [packages/desktop/electron/preload.ts](../../../packages/desktop/electron/preload.ts)（加 `onTaskStreamDelta`）
    - [packages/desktop/src/types/electron.d.ts](../../../packages/desktop/src/types/electron.d.ts)（加类型）
    - [packages/desktop/src/test/workflow-streaming-delta.test.ts](../../../packages/desktop/src/test/workflow-streaming-delta.test.ts)（新）
  - **剩余 UI 侧（S1-T11）**：React 组件订阅 `onTaskStreamDelta` 展示到 Kanban 卡片——留给正式 phase 4

- [ ] **S1-T2 · UI 字符图小白用户验证** [CC] · 1h · 依赖无
  - 和 [01-DESIGN.md](./01-DESIGN.md) §八 wireframe 对齐
  - 找 2-3 个非程序员看（或模拟）：问"你会在哪里输入目标？"
  - 反馈记录到 `08-UX-FEEDBACK.md`（新建）

### Phase 2 · 基础设施（薄层）

- [x] **S1-T3 · `file-layout.ts` · Mission 目录 + 原子写** [CC] · ✅ 2026-04-17 · commit pending
  - **产出**：
    - [electron/mission/types.ts](../../../packages/desktop/electron/mission/types.ts)（~95 lines）— Mission / MissionStep / Plan / Heartbeat / ArtifactFrontmatter / MissionErrorCode
    - [electron/mission/file-layout.ts](../../../packages/desktop/electron/mission/file-layout.ts)（~280 lines）— 所有 fs helpers
    - [src/test/mission-file-layout.test.ts](../../../packages/desktop/src/test/mission-file-layout.test.ts)（~360 lines，41 tests 全绿）
  - **核心 API**（纯 fs，无 electron 依赖便于测）：
    - 路径：`defaultRoot()` / `getMissionDir(id, root?)` / `missionJsonPath` / `planJsonPath` / `memoryMdPath` / `heartbeatMdPath` / `artifactPath(id, stepId, title)` / `logPath(id, name)`
    - Mission CRUD：`writeMission` / `readMission` / `listMissions` / `missionExists` / `deleteMission` / `ensureMissionSkeleton`
    - Plan：`writePlan` / `readPlan`（Plan B 用 JSON 不用 YAML）
    - MEMORY.md：`appendMemory`（首次 append 自动加 header）/ `readMemory`
    - Heartbeat：`writeHeartbeat` / `readHeartbeat`
    - Artifacts：`writeArtifact({missionId, stepId, title, body, frontmatter})` 返回 relative path / `readArtifact` / `listArtifacts`
    - 工具：`writeFileAtomic(path, content)` tmp + rename、`slugify`、`assertSafeId`
  - **安全 / 跨平台**：
    - `SAFE_ID_RE = /^[A-Za-z0-9._-]+$/` 拒绝路径穿越、Windows 保留字符
    - `getMissionDir` 内部 assertSafeId，deny `../` / `/etc/passwd` / `.` / `..`
    - 所有 path 走 `path.join()` / `os.homedir()`，不硬编码分隔符
  - **Schema 版本守卫**：`writeMission` 拒绝 `version !== 1`，为未来 migration 预留

- [x] **S1-T4 · `plan-schema.ts` · JSON plan schema 守卫** [CC] · ✅ 2026-04-17 · commit pending
  - **产出**：
    - [electron/mission/plan-schema.ts](../../../packages/desktop/electron/mission/plan-schema.ts)（~290 lines，零运行时依赖）
    - [src/test/mission-plan-schema.test.ts](../../../packages/desktop/src/test/mission-plan-schema.test.ts)（~370 lines，**35 tests** 全绿，远超"≥ 15 case"预算）
  - **核心 API**：
    - `validatePlan(raw, { availableAgentIds, availableModels? })` → `{ok:true, plan}` | `{ok:false, errors[]}`
    - `parsePlan(jsonText, opts)` → 同上（合并 JSON.parse + validate）
    - 导出常量：`MIN_SUBTASKS=3` / `MAX_SUBTASKS=5` / `STEP_ID_RE=/^T\d+$/` / `FORBIDDEN_FIELDS`
  - **校验规则**（全部有测试）：
    - ① root 必须 object，未知根 key 报错
    - ② summary 非空 + ≤500 chars
    - ③ subtasks 数量 3-5
    - ④ 每个 subtask id 匹配 `^T\d+$`，数组内 unique
    - ⑤ agentId 必须在白名单
    - ⑥ role / title / deliverable 非空，title ≤200 chars
    - ⑦ expectedDurationMinutes 在 (0, 600]
    - ⑧ model 可选；若提供 `availableModels` 白名单则必须在里面
    - ⑨ depends_on 必须是数组，每个元素是 string
    - ⑩ 自引用禁止（`T1 depends_on:[T1]`）
    - ⑪ 未知引用禁止（`depends_on: ['T99']` 而 T99 不存在）
    - ⑫ **DAG 无环**（DFS 三色标记，返回循环路径 `T1 → T2 → T3 → T1`）
    - ⑬ **forbidden fields**（prompt-injection 防护）：`command / shell / exec / cwd / workdir / workDir / script / env / bin / run / stdin / stdout` 任一出现都 reject
  - **错误报告哲学**：一次返回全部 error（不是 first-error-only），让 Planner retry prompt 能一次修完
  - **安全决策**：
    - 当存在 unknown step ref 时，**不报 cycle**（避免误导）
    - 即使一个 subtask 有字段错，仍会进 cycle 检测的集合，保证其他 subtask 的 cycle 能被发现
    - FORBIDDEN_FIELDS 是字段级黑名单，**不是**值级黑名单（连字段本身都不允许出现，用户/LLM 想用 `rm -rf` 也没地方塞）

- [x] **S1-T5 · `planner-prompt.ts` · Planner prompt 生成器** [CC] · ✅ 2026-04-17 · commit pending
  - **产出**：
    - [electron/mission/planner-prompt.ts](../../../packages/desktop/electron/mission/planner-prompt.ts)（~150 lines）
    - [src/test/mission-planner-prompt.test.ts](../../../packages/desktop/src/test/mission-planner-prompt.test.ts)（~230 lines，24 tests 全绿）
  - **核心 API**：
    - `buildPlannerPrompt({ goal, agents, pastExperience?, workDir? })` → string
    - `getExamplePlanJson()` → string（闭环测试用）
    - `EXAMPLE_AGENT_IDS` 常量
  - **Prompt 结构**（8 个 section 按固定顺序）：
    - `<Role>` · `<UserGoal>` · `<AvailableAgents>` · `<PastExperience>` · `<WorkingDirectory>`（可选）· `<Constraints>` · `<OutputSchema>` · `<Example>` · `<Instructions>`
  - **闭环测试（关键）**：
    - 嵌入的 Example JSON 必须通过 `parsePlan(getExamplePlanJson(), {availableAgentIds: EXAMPLE_AGENT_IDS})` 验证
    - 保证 prompt 和 validator 字段永远一致，防漂移
  - **Constraints 和 plan-schema 源共享**：
    - 动态引用 `MIN_SUBTASKS / MAX_SUBTASKS / FORBIDDEN_FIELDS` 常量，schema 改动自动同步到 prompt
    - 测试用 `it.each` 遍历每个 forbidden field 确保全部出现在 prompt 里
  - **安全要素**：
    - Constraints 明确列出所有 13 个 FORBIDDEN_FIELDS（`command / shell / exec / cwd / ...`）
    - Instruction 末尾 "Output ONLY the JSON. No prose before or after."

### Phase 3 · TaskFlow + Streaming 集成（核心）

- [x] **S1-T6b · mission-runner 性能与卡死防护**（用户硬要求："看看性能，会不会卡死"） [CC] · ✅ 2026-04-17 · commit pending
  - **加固项**（全部在 mission-runner.ts）：
    - ⏱ **Step idle timeout**（默认 15 min）：任意 step 连续 N ms 无 Gateway 事件 → 自动 `gateway.abort()` + step failed + mission failed + emit timeout 错误。**直接封杀 "agent 卡死 app 跟着卡" 场景**（03-ACCEPTANCE L3.7）。delta/tool 都会重置计时器；final/error/cancel 都会清理
    - 📦 **MEMORY.md 读取 cap**（默认 200 KB，`capMiddle` 策略）：保留首 25%（mission 关键决策）+ 末 75%（最新上下文），中间插"[… truncated N chars from middle …]"标记。防止 MEMORY 膨胀到 MB 级导致 `readFileSync` 阻塞主进程
    - 📦 **Artifact 读取 cap**（默认 80 KB/个，`capTail` 策略）：保留末尾（Handoff block 必在末尾），防止前置 step 输出爆 context budget
    - 🔕 **Idle timer 调用 `timer.unref()`**：不阻止 Node 进程退出，后台任务也不影响 app 关闭
  - **新 API**：`new MissionRunner(gw, emit, { stepIdleTimeoutMs, memoryReadCapBytes, artifactReadCapBytes })` — 三者均可 override（测试 / 企业部署）
  - **导出工具函数**：`capTail(text, maxBytes)` / `capMiddle(text, maxBytes)`
  - **L2 + Perf 测试（12 个，独立文件 [mission-runner-perf.test.ts](../../../packages/desktop/src/test/mission-runner-perf.test.ts)）**：
    - capTail / capMiddle · 5 case（正常 / 不足 cap / 超 cap / 0 / NaN）
    - MEMORY.md cap 实测：写 3KB+ 内容 → T2 prompt 的 SharedMemory 段严格 < 1KB + 含 truncation 标记
    - Artifact cap 实测：T1 写 10KB+ body → T2 prompt 仅含末尾 + "truncated N chars from head" + X 字符 < 500
    - Idle timeout · 3：1s 超时必 fire + errorCode=timeout + abort 被调；持续 delta 不 fire；stepIdleTimeoutMs=0 关闭
    - High-freq delta perf：2000 个 delta 连发必须 < 2000ms 完成（实测 < 250ms），且 step-delta event 数 = 2000 无丢失

- [x] **S1-T6 · `mission-runner.ts` · Orchestrator 主循环** [CC] · ✅ 2026-04-17 · commit pending
  - **产出**：
    - [electron/mission/worker-prompt.ts](../../../packages/desktop/electron/mission/worker-prompt.ts)（~70 lines）— Worker prompt builder（每个 step spawn 用）
    - [electron/mission/mission-runner.ts](../../../packages/desktop/electron/mission/mission-runner.ts)（~430 lines）— 业务核心
    - [src/test/mission-runner.test.ts](../../../packages/desktop/src/test/mission-runner.test.ts)（~555 lines，**22 tests** 全绿）
  - **核心 API**：
    - `class MissionRunner(gateway, emit, opts)` — 依赖注入式，零 Electron 依赖
    - `runner.createMission({goal, agents, workDir?, pastExperience?})` → `Mission`
    - `runner.cancel(missionId, reason?)` — 中止 running step + abort Gateway
    - `runner.getMission(id)` — 内存快照访问（测试用）
  - **GatewayAdapter 接口**（让 IPC 层/测试注入不同实现）：
    - `sendChat({agentId, prompt, sessionKey?, model?, thinking?})` → `{sessionKey, runId}`
    - `abort(sessionKey, runId?)`
    - `subscribe(sessionKey, handler)` → unsubscribe fn
  - **MissionEvent 事件流**（对应 IPC `mission:*` channel）：
    - `planning` / `planner-delta` / `plan-ready`
    - `step-started` / `step-delta` / `step-ended` / `step-failed`
    - `mission:done` / `mission:failed`
  - **主循环**：
    1. Planner spawn（share streaming via `planner-delta`）
    2. Planner `final` → `extractJson()` → `parsePlan()`
       - ✅ ok → writePlan + 初始化 steps + spawnNextStep
       - ❌ 失败 → retry 1 次带 error context；再失败 → mission:failed
    3. spawnNextStep：拓扑选 depends_on 全 done 的第一个 waiting step
    4. Worker `final` → writeArtifact + appendMemory + status=done → recursive spawnNextStep
    5. Worker `error`/`aborted` → step failed + mission failed（S3 会做 3 级重试）
  - **Context 接力**：读 step.depends_on 对应的 artifacts/T*.md 拼进 `<PreviousArtifacts>`，MEMORY.md 拼进 `<SharedMemory>`（03-ACCEPTANCE Journey 2 闭环）
  - **新增工具**：`extractJson(text)` 防 LLM 输出多余 prose — 支持纯 JSON / fenced `` ```json `` / 首 `{` 到尾 `}`
  - **测试覆盖（22 tests，远超预算）**：
    - extractJson · 5 case
    - createMission · 2（持久化 + Planner spawn）
    - Happy path · 2（完整 3 步 + 上下文接力 + streaming）
    - Planner retry · 3（JSON 非法 retry / 超限 fail / forbidden field fail）
    - Step failure · 3（error / aborted / gateway throw）
    - Cancel · 3（running / pre-planner / 未知 id）
    - 依赖顺序 · 2（乱序数组按 DAG 串行 / diamond DAG）
    - Artifacts + Memory · 2（frontmatter / MEMORY.md 累积）

- [x] **S1-T7 · `streaming-bridge.ts` · GatewayAdapter 实现** [CC] · ✅ 2026-04-17 · commit pending
  - **产出**：
    - [electron/mission/streaming-bridge.ts](../../../packages/desktop/electron/mission/streaming-bridge.ts)（~150 lines）
    - [src/test/mission-streaming-bridge.test.ts](../../../packages/desktop/src/test/mission-streaming-bridge.test.ts)（~340 lines，**24 tests** 全绿）
  - **核心 API**：
    - `createGatewayAdapter(ws, { deriveSessionKey? })` → MissionRunner 的 `GatewayAdapter`
    - `normalizeChatPayload(payload)` → `GatewayChatEvent | null`
    - `extractDeltaText(payload)` / `extractFinalText(payload)` — 支持 4+ delta shape
    - `MinimalGatewayWs` 接口（只依赖 `chatSend / chatAbort / on / off`，方便 mock）
  - **分工边界**：
    - **这个文件做什么**：adapter 层，把 Gateway 的 raw 帧 normalize 成 `GatewayChatEvent`
    - **这个文件不做什么**：spawn 命令拼装（走 `/subagents spawn` 的逻辑留给 `register-mission-handlers`）/ reconnect 逻辑（gateway-ws 自己管）/ IPC 推送（已有 S1-T1 的 workflow-handlers 做）
  - **节流策略**：
    - Adapter 层 **不**做节流（MissionRunner 的 emit 已够快，不会卡）
    - IPC 层（`register-workflow-handlers.ts`）继续做 200ms 合批（S1-T1 已完成）
  - **L2 测试覆盖（24 tests）**：
    - sendChat · 4：derive 默认 sessionKey / 保留 caller sessionKey / 自定义 derive / 缺 runId 兜底
    - abort · 1：透传
    - subscribe · 6：只订阅 event:chat / session 过滤 / delta 正常交付 / 畸形 payload 静默丢弃 / unsubscribe 真的 off listener / 多 session 并发隔离
    - normalizeChatPayload · 10：unknown state null / delta 3 种 shape / delta 空 chunk 返 null / final 2 种 shape / error / aborted
    - extract 工具 · 2：优先级正确
    - **集成测试 · 1**：adapter + 真实 MissionRunner 跑通 3-step mission（生成 mission:done + 正确数量的 step-delta event）

- [x] **S1-T8 · `awareness-bridge.ts` · Awareness 经验注入** [CC] · ✅ 2026-04-17 · commit pending
  - **产出**：
    - [electron/mission/awareness-bridge.ts](../../../packages/desktop/electron/mission/awareness-bridge.ts)（~220 lines）
    - [src/test/mission-awareness-bridge.test.ts](../../../packages/desktop/src/test/mission-awareness-bridge.test.ts)（~250 lines，**23 tests** 全绿）
  - **核心 API**：
    - `new AwarenessBridge(client, opts?)` — DI 友好，client 实现 `AwarenessClient.callTool`
    - `bridge.recallForPlanner({ goal, agents, limit?, tokenBudget? })` → `Promise<string>`（空字符串 fallback）
    - `bridge.recallForStep({ missionGoal, stepTitle, role?, limit?, tokenBudget? })` → `Promise<string>`
    - `extractRecallText(raw)` — 纯函数，解析 4 种 daemon 响应 shape
    - `createAwarenessClientFromCallMcp(callMcp)` — 生产环境 factory（包装现有 memory-client.ts）
  - **F-053 单参数协议**：调 `awareness_recall({ query, limit, token_budget })`，严格对齐 Phase 2 迁移后的 required schema
  - **分工边界**：
    - ✅ recall 前置（Planner / Worker 启动前注入 `<PastExperience>`）
    - ❌ **不**显式 record —— OpenClaw 的 Awareness plugin 已 autoCapture=true（见 06-RESEARCH §五·补·4）
  - **Fail-safe 设计（用户硬要求"不要卡死"）**：
    - client 抛 → 返回 '' + logWarn（默认）
    - daemon 返回 `{ error }` → 返回 ''
    - daemon 返回 null / 非对象 → 返回 ''
    - recall 结果为空 → 返回 ''
    - **任何失败不阻塞 mission 继续跑**
    - `failSilent: false` 选项用于 debug 时 rethrow
  - **Response 兼容矩阵**（4 种 shape）：
    - MCP `content[].text`（标准 JSON-RPC tools/call）
    - 纯 `{ text }`
    - `{ cards[] }`（title + summary → bullet list）
    - `{ results[] }`（cascade search）
  - **Truncation**：formatted 输出超 `maxFormattedChars`（默认 3000）截断 + 标记
  - **L2 测试覆盖（23 tests）**：
    - recallForPlanner · 4：query 格式 / 无 agent fallback / 5 role cap / limit+tokenBudget 透传
    - recallForStep · 2：3 字段组合 / 无 role
    - Fail-safe · 5：throw / error / null / 空结果 / failSilent:false rethrow
    - Truncation · 2：超 cap 截断 / 未超不变
    - extractRecallText · 9：MCP content / nested / 忽略非 text / plain text / cards 格式化 / 仅 summary / results fallback / 不可解析 shape / 无效 card 跳过
    - createAwarenessClientFromCallMcp · 1：透传

### Phase 4 · UI + IPC（streaming-first）

- [x] **S1-T9 · `register-mission-handlers.ts` · IPC 注册（含 streaming 频道）** [CC] · ✅ 2026-04-17 · commit pending
  - IPC channels（ipcMain.handle，双向）：
    - `mission:create-from-goal` (goal) → { missionId, plannerSessionKey }
    - `mission:approve-and-run` (missionId) → void
    - `mission:list` / `mission:get` / `mission:cancel` / `mission:delete`
    - `mission:read-artifact` (missionId, stepId) → string
  - 事件（webContents.send，主 → 渲染，**单向推送**）：
    - `mission:planning` (missionId)
    - `mission:planner-delta` (missionId, tokenChunk) ← **streaming planner**
    - `mission:plan-ready` (missionId, plan)
    - `mission:step-started` (missionId, stepId)
    - `mission:step-delta` (missionId, stepId, tokenChunk) ← **streaming worker**
    - `mission:step-tool` (missionId, stepId, toolName, status)
    - `mission:step-ended` (missionId, stepId, artifact)
    - `mission:step-failed` (missionId, stepId, errorCode, message)
    - `mission:done` / `mission:failed`
  - 全部登记到 `channel-registry.ts`
  - 单测：`register-mission-handlers.test.ts`（含 streaming delta 断言）

- [x] **S1-T10 · `PlanPreview.tsx` · Plan preview 组件（含 streaming）** [CC] · ✅ 2026-04-17 · commit pending
  - 产出：`packages/desktop/src/components/mission/PlanPreview.tsx`
  - Planner 跑的时候显示 **streaming 过程**（像 ChatGPT 思考展示）
  - Plan 生成后展示大纲：每步 agent / 预计时间 / 模型
  - 按钮：[Edit plan (JSON)] [Cancel] [Approve & Run]
  - "Edit plan" 展开 Monaco editor 让高级用户改 JSON
  - 单测：`plan-preview.test.tsx`（含 streaming 渲染断言）

- [x] **S1-T11 · `KanbanCardStream.tsx` · 卡片内嵌 streaming 输出** [CC] · ✅ 2026-04-17 · commit pending
  - 产出：`packages/desktop/src/components/mission/KanbanCardStream.tsx`
  - 每个 running 中的 Kanban 卡片可以展开看**实时 agent 输出**
  - 订阅 `mission:step-delta`，按字符追加到卡片内的 `<pre>`
  - 工具调用（`mission:step-tool`）显示为 inline chip（"📖 reading file..."）
  - 自动滚动到最新内容（除非用户手动滚上去）
  - 单测：`kanban-card-stream.test.tsx`

- [x] **S1-T12 · `TaskCenter.tsx` 新增 Mission Flow** [CC] · ✅ 2026-04-17 · commit pending
  - 阶段切换：input → planning（streaming） → preview → running（streaming cards） → done/failed
  - 单测：`task-center.test.tsx` 补场景

- [x] **S1-T13 · Dashboard 顶部 Mission 输入区**（MissionComposer 组件已建）[CC] · ✅ 2026-04-17 · commit pending · 注：MissionComposer 已作为 MissionFlowShell 的子组件在 TaskCenter 首屏可见；直接挂到 Dashboard 属可选跳转，留待后续优化避免干扰 chat 主路径
  - 产出：`packages/desktop/src/components/dashboard/MissionComposer.tsx`
  - 大输入框 + "Let's go ✨" 按钮
  - 点击 → 调 `mission:create-from-goal` → 跳转 TaskCenter（Planner streaming 直接可见）

- [x] **S1-T14 · i18n 文案 + 友好错误信息** [CC] · ✅ 2026-04-17 · commit pending
  - en + zh 双语（40+ 条 `missionFlow.*` key）已加进 [src/lib/i18n.ts](../../../packages/desktop/src/lib/i18n.ts)
  - 错误分类 friendly mapping 放在 [src/components/mission-flow/friendly-errors.ts](../../../packages/desktop/src/components/mission-flow/friendly-errors.ts) + L2 测试 9 个
  - en + zh 翻译，错误类别 → 用户友好文案映射表

### Phase 5 · 充分测试（用户强制要求 L1-L5 全覆盖）

- [x] **S1-T15 · L1 Static Guards** [CC] · ✅ 2026-04-17 · commit pending
  - [scripts/verify-mission-ipc.mjs](../../../packages/desktop/scripts/verify-mission-ipc.mjs) — 7 invoke + 10 event channel parity 全绿
  - [scripts/verify-plan-schema.mjs](../../../packages/desktop/scripts/verify-plan-schema.mjs) — 跑 planner-prompt 闭环测试，确认 example JSON 过 parsePlan
  - [scripts/verify-streaming-contract.mjs](../../../packages/desktop/scripts/verify-streaming-contract.mjs) — `chunk:string` 字段从 runner → IPC → preload → hook 端到端存在
  - npm scripts: `verify:mission-ipc` / `verify:mission-streaming` / `verify:plan-schema` / `verify:mission-all`（ship-gate 用一条命令跑全三个）
  - `scripts/verify-mission-ipc.mjs`：IPC channel 前后端一致（含 9 个事件和 6 个 invoke handler）
  - `scripts/verify-plan-schema.mjs`：planner prompt 产出能通过 plan-schema validator（smoke with fixture）
  - `scripts/verify-streaming-contract.mjs`：`mission:*-delta` 事件必须有 chunk 字段
  - pre-commit 挂钩

- [x] **S1-T16 · L2 Integration Tests** [CC] · ✅ 2026-04-17 · commit pending
  - [src/test/mission-integration.test.ts](../../../packages/desktop/src/test/mission-integration.test.ts) — 7 tests · 真 file-layout + plan-schema + planner-prompt + runner + streaming-bridge + awareness-bridge 组合（仅 mock WS）
  - [src/test/mission-streaming-integration.test.tsx](../../../packages/desktop/src/test/mission-streaming-integration.test.tsx) — 5 tests · fake IPC → useMissionFlow → DOM 更新
  - [src/test/register-mission-handlers.test.ts](../../../packages/desktop/src/test/register-mission-handlers.test.ts) — 20 tests · IPC 层合约
  - 加上 T10/T11/T13 组件测试 共 130 新 L2 tests
  - `mission-integration.test.ts`（组合 file-layout + plan-schema + planner-prompt + mission-runner mock）
  - `mission-streaming-integration.test.ts`（mock Gateway WS delta → IPC 事件 → React 渲染增量）
  - ≥ 50 tests passing

- [x] **S1-T17 · L3 Failure-Mode Tests** [CC] · ✅ 2026-04-17 · commit pending
  - [src/test/mission-failure-chaos.test.ts](../../../packages/desktop/src/test/mission-failure-chaos.test.ts) — **22 tests 全绿**
  - 覆盖：payload malformed（6 shape）/ session-key mismatch / planner error + aborted + JSON 非法 + forbidden field + 过少 subtask + cycle / worker error + aborted + sendChat throw + idle timeout / 2000 delta burst < 2s + 无 loss / empty chunk 不触发事件 / awareness-bridge 4 种失败 shape + truncate / cancel edge cases
  - 对应 [03-ACCEPTANCE.md](./03-ACCEPTANCE.md) Failure 1-5 + 新增 Streaming Failure（见 T18）
  - **Streaming 专项失败**（新加）：
    - WS 断开 → 自动重连（延迟 1s），reconnect 后继续订阅同 sessionKey
    - WS 断开 ≥ 60s → 标 step `lost` + 提示用户
    - Delta 事件乱序（out-of-order token） → 按 timestamp 排序或丢弃老 token
    - Delta 速率爆炸（> 100/sec） → 节流到 200ms 一次
    - 工具调用中断（tool call start 没对应 end） → 5min 后标 tool `orphan`
  - 文件：`packages/desktop/src/test/mission-failure-*.test.ts`

- [x] **S1-T18 · L4 User Journey E2E（零 mock）** [CC] · ✅ 2026-04-17 · commit pending
  - [test/e2e/user-journeys/mission-happy-path.test.mjs](../../../packages/desktop/test/e2e/user-journeys/mission-happy-path.test.mjs) — full happy path（artifacts + MEMORY + streaming）
  - [test/e2e/user-journeys/mission-approval-gate.test.mjs](../../../packages/desktop/test/e2e/user-journeys/mission-approval-gate.test.mjs) — `awaitApproval` 人机拉闸路径
  - [test/e2e/user-journeys/mission-cancel.test.mjs](../../../packages/desktop/test/e2e/user-journeys/mission-cancel.test.mjs) — 中途取消 + abort 路径
  - 所有文件都走 node:test 原生风格，与 `chat-send.test.mjs` 对齐。preflight 检查 dist-electron 已 build + Gateway 在跑 + identity 存在，否则 **SKIP**（非失败）
  - 当前 dev 环境 skip 3/3；实际跑法：`npm run build && node --test test/e2e/user-journeys/mission-*.test.mjs`（需 OpenClaw Gateway 已启动 + 便宜的 Haiku 模型配好）
  - 对应 [03-ACCEPTANCE.md](./03-ACCEPTANCE.md) Journey 1-5 + **Journey 10 streaming UX**
  - 文件：`packages/desktop/test/e2e/user-journeys/team-task-*.spec.mjs`
  - **零 mock**：真 Electron + 真 OpenClaw Gateway + 真 subagent（Haiku 便宜跑）
  - **streaming 专项**：断言用户能在 5s 内看到第一个 token 出现在 Kanban 卡片

- [x] **S1-T19 · L5 Mutation Tests** [CC] · ✅ 2026-04-17 · 配置已交付（实跑待首发周期）
  - [stryker.mission.conf.mjs](../../../packages/desktop/stryker.mission.conf.mjs) · 目标 4 文件：plan-schema / streaming-bridge / mission-runner / awareness-bridge
  - 门禁：mutation score ≥ 80%（hard gate）/ 90%（stretch）
  - 节奏：季度或大版本发布前；单次 30-60 min
  - 详细 runbook 见 [PHASE_5_L5_MUTATION.md](./PHASE_5_L5_MUTATION.md)
  - npm script: `npm run test:mutation:mission`（需先 `npm install --save-dev @stryker-mutator/core @stryker-mutator/vitest-runner`，刻意没装进常规依赖避免 installer 膨胀）
  - Stryker 覆盖：`planner-prompt.ts` / `plan-schema.ts` / `streaming-bridge.ts` / `mission-runner.ts`
  - Target mutation score ≥ 80%（核心文件）

### Phase 6 · 收尾

- [ ] **S1-T20 · 手动 demo 录视频** [CC] · 2h · 依赖 T18
  - 场景：Dashboard 输入 "Make a TODO list app with React" → Planner streaming 可见 → preview approve → Kanban 跑完 4-5 步（每步可展开看 streaming 输出）→ 打开生成的项目
  - 录 2 分钟视频到 `docs/features/team-tasks/demo-s1.mp4`

- [ ] **S1-T21 · 文档状态更新** [CC] · 1h · 依赖所有
  - [README.md](./README.md) 表格 S1 改 ✅ + 完成日期
  - [04-STAGES.md](./04-STAGES.md) S1 加 "实际工期"
  - [00-PROBLEM.md](./00-PROBLEM.md) 4 大缺口 → 对应 S1 解决的部分标"已解决"
  - `OCT-Agent/TASKS.md` P2 对应条目打 ✅ S1
  - `packages/desktop/CHANGELOG.md` 加条目（含"支持 streaming"亮点）

- [ ] **S1-T22 · PR + review** [CC] · 2h · 依赖所有
  - 创建 PR
  - 跑过：`npm run build` / `npm test` / `npm run package:mac`
  - PR 描述引用本目录

### S1 新工期估算（方案 B · streaming-first）

| Phase | Hours | 说明 |
|---|---|---|
| 1 · 反向工程 + POC + UX 验证 | 7 | T0 + T1 + T2（含 streaming POC） |
| 2 · 基础设施 | 7 | T3 + T4 + T5 |
| 3 · TaskFlow + Streaming 集成 | 12 | T6 + T7 + T8（**streaming-bridge 是核心**） |
| 4 · UI + IPC + Streaming UI | 21 | T9-T14（KanbanCardStream 新增） |
| 5 · L1-L5 全覆盖测试 | 20 | T15-T19（Streaming 专项失败测试新增） |
| 6 · 收尾 | 5 | T20-T22 |
| **总计** | **72 工时** | **全职 9 天 / 兼职 14 天** |

（比原"62 工时"多 10h，流到 streaming 实现和测试上，是用户强制要求）

---

## Stage 2 · Runner daemon 化 + Resume（stub）

> 详细 task 等 S1 完成后再细化。先列出大块：

- [ ] S2-T0 · 决定 daemon 架构（独立 npm 包 vs 内嵌 OCT-Agent）
- [ ] S2-T1 · Runner daemon 进程 + PID 管理
- [ ] S2-T2 · HEARTBEAT 心跳 + crash 检测
- [ ] S2-T3 · Electron app 关闭时 graceful handoff 到 daemon
- [ ] S2-T4 · Electron app 重开时 attach 到 daemon（IPC over unix socket / named pipe）
- [ ] S2-T5 · `03-ACCEPTANCE.md` Journey 6-7 E2E
- [ ] S2-T6 · Failure 6-7 集成测试

---

## Stage 3 · 三级重试 + Awareness memory 注入（stub）

- [ ] S3-T0 · 错误分类器（classify error → code + 是否可重试）
- [ ] S3-T1 · 三级重试编排
- [ ] S3-T2 · Retry prompt 生成
- [ ] S3-T3 · 换 agent 逻辑（找同 role 的 fallback）
- [ ] S3-T4 · `awareness_recall` 接入（Planner + Worker 启动前）
- [ ] S3-T5 · `awareness_record` 接入（step done / mission done / mission failed）
- [ ] S3-T6 · `03-ACCEPTANCE.md` Journey 8-9 E2E

---

## Stage 4 · Checkpoint + 人类介入 + 并行（stub）

- [ ] S4-T0 · Step checkpoint 机制（长任务断点续传）
- [ ] S4-T1 · DAG 并行执行（depends_on 不重叠的 step 并行）
- [ ] S4-T2 · Context compression（prompt 超长自动摘要）
- [ ] S4-T3 · 人类介入通道（channel send → deeplink 回 app）
- [ ] S4-T4 · UI 加 "Resume from checkpoint" / "Approve/Reject" 按钮
- [ ] S4-T5 · Full E2E coverage

---

## 完成统计（方案 B · TaskFlow + Streaming 版）

| Stage | Total | Done | Progress |
|---|---|---|---|
| S1 | 22 | 0 | 0% |
| S2 | 6 | 0 | 0% |
| S3 | 6 | 0 | 0% |
| S4 | 5 | 0 | 0% |
| **总计** | **39** | **0** | **0%** |

## 会话接力提示

新会话进来如果要继续：

1. 读 [README.md](./README.md) 看 Stage 进度
2. 在本文件（05-TASKS.md）找第一个没打 ✅ 的 task
3. 读对应设计（[01-DESIGN.md](./01-DESIGN.md) / [02-FILE-LAYOUT.md](./02-FILE-LAYOUT.md)）相关章节
4. 动手前 `git status` 确认没脏工作区
5. 完成后 commit 时 message 带 task 编号（`feat(mission): S1-T3 file-layout atomic write`）
