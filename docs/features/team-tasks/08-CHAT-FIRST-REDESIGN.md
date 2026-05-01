# 08 · Chat-First Redesign（preview.6）

> **拍板日期**：2026-04-18
> **定位彻底转向**：Mission Flow 从独立功能彻底下线，融入 chat 成为"AI 自主 sessions_spawn → 聊天流内嵌渲染"
> **用户原话**：「这个产品就是给普通用户用的」「chat 中的一个功能」「简单就好」「默认开 Telegram 推送」

---

## 一、做什么（一句话）

**普通用户只认 Chat。发 "帮我做个 PPT" → AI 自己决定要不要调用 `sessions_spawn` 拆子任务 → 子任务的 tool call 和 subagent delta 都渲染在**同一个**AI 气泡里 → 完成时 Telegram / 微信 push。**

**不做**：Mission Composer / Plan Preview / Kanban / 🎯 toggle / "后台任务"字眼。

---

## 二、架构决策

| 决策 | 原因 |
|---|---|
| Mission Flow UI 整个从主导航下线（TaskCenter tab 删除） | 和用户确认"Chat 是唯一主入口" |
| 保留主 agent 的 `sessions_spawn` 工具权限 | OpenClaw 已内置，零配置 |
| 复用现有 `ChatTracePanel` + `tool_use` 渲染 | **禁区**（用户反复强调 thinking/tools 不能碰坏） |
| `sessions_spawn` 的 tool call 块增强：展开显示 child delta | 在 `ChatTracePanel` 里加一个 subagent 子组件 |
| Resume 通过读 `~/.openclaw/tasks/runs.sqlite` (task_runs 表) | OpenClaw 自带 durable store，不造轮子 |
| Channel 推送走 `openclaw message send` | OpenClaw 原生 API，跨 Telegram/微信/WhatsApp 统一 |
| 默认开 Telegram 推送（用户拍板） | 首次安装自动选第一个已连通道；仅在任务耗时 >30s 时推 |

---

## 三、同时修的 3 个 chat bug（用户反复提）

| Bug | 根因调研结论 | 修法（最小侵入，保护 thinking/tool UI） |
|---|---|---|
| 最后一轮重复输出 | `register-chat-handlers.ts:1011-1057` retry 路径（Awareness memory bootstrap 失败 → CLI retry）无 dedup；final 帧双触发；streaming buffer 累积 | 加 `messageDeduper` utility：同一 runId+messageId 只可出 final 一次；retry 路径补发的 final 带 source 标记，UI 侧跳过已显示内容 |
| Thinking 散落多处小 UI | 架构本身对（ChatTracePanel 聚合），但 gateway event 乱序时 React state 可能新建多个 traceEvents 数组 | 加 `ensureSingleTracePanelPerMessage` guard：同 messageId 的所有 thinking/tool delta 必须去同一 trace entry |
| 性能 | ReactMarkdown 每 delta 全量 re-parse；IPC chunk 未节流；Dashboard.tsx:879 闭包重算 | (1) `React.memo` 包 ReactMarkdown + 自定义 comparator only on content change；(2) IPC delta 节流 ~50ms（累积小窗口）；(3) streamingContent 用 `useMemo` |

**保守原则**：所有修改**不改 IPC 契约、不改 event 名、不改 ChatTracePanel 字段结构**。只加 dedup / memo / throttle 层。

---

## 四、5 层测试计划

| 层 | 新增测试 | 阻塞 preview.6 |
|---|---|---|
| **L1** | `verify-chat.mjs`：ChatTracePanel 必有 thinking+toolUse+sessions_spawn 渲染分支；主导航无 TaskCenter；chat event list 稳定不变 | ✅ |
| **L2** | `chat-dedup.test.ts`：同 runId 二次 final 应丢弃；retry 路径模拟；`chat-perf-memo.test.tsx`：ReactMarkdown 对相同 content 不重 render；`session-spawn-inline.test.tsx`：tool_use name=sessions_spawn 时渲染 subagent section | ✅ |
| **L3 chaos** | Gateway 乱序 final（tool_result 先于 assistant final）；child_session_key 404；sqlite 读失败；channel push 5xx+timeout+channel-未连 | ✅ |
| **L4 真 E2E** | `chat-sessions-spawn-happy.test.mjs`：发 "写封邀请邮件" → 若 main agent 拆子任务则看到 inline 渲染，否则看到单次回复；完成时 mock Telegram 收到消息；关 app 重开气泡仍在 | ✅ |
| **L5** | Stryker 季度 | ✗ |

---

## 五、下线清单（基于调研 Agent 给的 82 文件分析）

**主导航层（REFACTOR）**：
- `src/App.tsx` · 删 `currentPage === 'taskCenter'` 分支
- `src/components/Sidebar.tsx` · 删 taskCenter nav item + Page type

**页面/组件层（DELETE）**：
- `src/pages/TaskCenter.tsx`
- `src/components/mission-flow/*`（7 文件）
- `src/components/task-center/*`（8 文件，旧 workflow 遗留）

**Electron 层（DELETE）**：
- `electron/mission/*`（8 文件，包括 mission-runner / streaming-bridge / planner-prompt / plan-schema / file-layout / worker-prompt / types / awareness-bridge）
- `electron/ipc/register-mission-handlers.ts`
- `electron/preload.ts` 删 `missionStart` / `missionListActive` 暴露

**数据层（DELETE）**：
- `src/lib/mission-store.ts`

**测试（DELETE）**：
- `src/test/mission-*.test.ts(x)`（15 文件）
- `src/test/task-*.test.ts(x)`（4 文件）
- `test/e2e/user-journeys/mission-*.test.mjs`（3 文件）
- `scripts/verify-mission-*.mjs`（4 文件）
- `scripts/e2e-mission-smoke.mjs`
- `stryker.mission.conf.mjs`

**i18n（DELETE）**：
- `src/lib/i18n.ts` 删 `nav.taskCenter` / `taskCenter.*` / `missionFlow.*` / `task.*` 约 25 条

**新增**：
- `scripts/verify-chat.mjs`（替换 verify-mission-all）
- `src/components/dashboard/TraceSubagentSection.tsx`（sessions_spawn 内嵌渲染）
- `electron/chat/openclaw-sqlite.ts`（只读 task_runs sqlite）
- `electron/chat/channel-notify.ts`（完成通知）
- `src/lib/chat-dedup.ts`（dedup utility）
- `src/lib/react-markdown-memo.tsx`（memo 包装器）

---

## 六、Channel 推送规则（默认开）

1. **首次启动**：检测已连 channel（openclaw channels list）
2. **自动选**：优先 Telegram > WhatsApp > 微信 > 其他；无已连则关闭
3. **触发条件**：AI 气泡耗时 ≥30 秒（避免短对话骚扰）
4. **推送内容**：纯文本 + `awarenessclaw://messages/<sessionKey>?message=<id>` deep link
5. **文案**：
   ```
   🤖 OCT-Agent
   任务完成: 帮我写一封邀请邮件 (2 min 41s)
   [查看完整结果](awarenessclaw://...)
   ```
6. **Settings 可关**：Settings → Notifications → "Notify me on long chats" toggle

---

## 七、Resume 规则

1. App 启动时对每个活跃 chat session（~/.openclaw/sessions/\*.jsonl 里最近 24h 有活动的）：
   - `SELECT * FROM task_runs WHERE requester_session_key = ? AND status IN ('running','queued')`
   - 如有 hit：在 chat 对应的 bubble 底部加一行 "🔄 上次有 N 个子任务还在进行，已重新订阅"
2. Gateway 重启时 child_session_key 死：UI 显示 ⚠️ "子任务因 Gateway 重启已终止，可重新发送"（不自动重跑，避免双倍工作）
3. **零自建存储**：不写任何 mission.json

---

## 八、工时估算

| 阶段 | 耗时 |
|---|---|
| 落盘文档 | 30min ✅ |
| 删 MissionFlow 主导航（低风险首刀） | 1h |
| TDD L2 测试（chat 三 bug + inline） | 2h |
| 修 chat 三 bug | 2h |
| ChatTracePanel 升级 subagent inline | 1.5h |
| channel push + sqlite resume | 2h |
| 删底层 MissionFlow 代码（78 文件大扫除） | 1.5h |
| L1 + L3 + L4 测试 | 2h |
| vitest 全绿 + build + verify | 1h |
| DMG + smoke + CHANGELOG | 1h |
| commit + SDK sync | 0.5h |
| **合计** | **~15h** |

---

## 九、回滚策略

每个阶段完成后 git commit，保留可回滚：
1. `feat: redesign chat-first baseline (docs + snapshot)` ← 现在
2. `refactor: remove MissionFlow main nav entry (TaskCenter tab)`
3. `fix(chat): dedup + thinking aggregation + markdown memo`
4. `feat(chat): sessions_spawn inline rendering in tracepanel`
5. `feat(chat): channel notify + openclaw sqlite resume`
6. `refactor: full MissionFlow code removal + i18n cleanup`
7. `chore: verify-chat L1 + chat chaos L3 + new E2E`
8. `release: OCT-Agent 0.3.7-preview.6`

任一 step 破坏 vitest 或 chat UI → git reset 回上一 commit，不往前走。
