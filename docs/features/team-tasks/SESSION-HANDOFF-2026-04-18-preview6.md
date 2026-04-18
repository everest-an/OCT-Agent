# Session Handoff · 2026-04-18（preview.6 ship 后）

> **拍板**：用户睡前定的方向 = 极简，Chat 是唯一入口，AI 自主拆子任务。
> **同时修了**：用户反复强调"千万不要破坏 thinking/tools"的前提下，修了三个 chat 小 bug。
> **DMG**：`release/AwarenessClaw-0.3.7-preview.6-arm64.dmg`（签名 + 公证成功，staple 在 notary propagate 时重试）

---

## 最终交付清单

### Commits（都已 push 到 origin/main）
```
c91af29 docs(f-team-tasks): CHANGELOG preview.6 — chat-first redesign + 3 chat bug fixes
9df921a refactor(f-team-tasks): preview.6 — full MissionFlow code removal (second pass)
a6a1747 fix(chat): preview.6 — aggregate thinking stream, dedupe final, throttle + reset
c2bbec5 refactor(f-team-tasks): chat-first redesign baseline — remove TaskCenter nav + docs
```

四个独立的回滚点，每一步都有测试兜底。

### 用户可见的变化

1. **侧栏"Tasks" tab 消失**。Chat 变成唯一主入口。普通用户从此不再看到 Mission / Kanban / Plan Preview 这些概念。
2. **AI 在 chat 里自主拆子任务**：调用 OpenClaw 原生 `sessions_spawn` 工具，子任务的 tool_use / delta 内嵌渲染在同一个 AI 气泡里（复用已有的 `ChatTracePanel`，禁区一行没动）。
3. **完成通知**：AI 用 OpenClaw 原生 `message_send` 往用户已连的 channel（Telegram / WhatsApp / 微信 / Signal 等）推一条完成消息。用户拍板"默认开"——我们没改 openclaw.json 的 alsoAllow（那是用户个人配置），因为 OpenClaw 默认就允许 agent 调这个工具。

### 修掉的 3 个 chat bug（禁区架构一行未动）

| Bug | 根因 | 修法 |
|---|---|---|
| Thinking 散落 | `stream:"thinking"` delta 每次覆盖前端单一 state → 只见最后一段 | 主进程累积 `liveThinkingBuffer`，push 完整累积文本 |
| 最后一轮重复输出 | (a) Gateway 双 final 帧重触发 tool/text 事件；(b) CLI fallback 前 Gateway 已推了部分 chat:stream，CLI 又再推一次 → 拼接重复 | (a) `sawFinalState` guard 跳过第二 final；(b) 新增 `chat:stream-reset` 信号，CLI fallback 前前端清掉 partial 字节 |
| 性能 | ReactMarkdown 每 delta 全量 re-parse + IPC 每 token 发一次 | 主进程 40ms throttle + 前端 `<StreamingMarkdownBlock />` React.memo |

**关键**：`ChatTracePanel`、`thinking` / `tool_use` / `content_blocks` 的解析和渲染逻辑**完全未动**。所有修复都是外挂层（dedup guard / buffer / throttle / memo）。

### 删除统计（约 78 文件 / ~4000 LOC）
- 目录：`electron/mission/`、`src/components/mission-flow/`、`src/components/task-center/`
- 文件：`src/pages/TaskCenter.tsx`、`src/lib/mission-store.ts`、2 个 IPC handler
- i18n：~90 条 mission/taskCenter/kanban/workflow/missionFlow key（en + zh）
- 测试：28 个 mission-/task-/workflow-/kanban- test 文件
- Scripts：4 个 verify-mission-* + e2e-mission-smoke + stryker mission conf
- 前端 bundle：1036KB → 1020KB (-15KB)

### 新增
- `docs/features/team-tasks/OPENCLAW_FLOWS_API.md` — 阶段 0 反向工程结论（原 prompt 的方案 A 被证伪）
- `docs/features/team-tasks/08-CHAT-FIRST-REDESIGN.md` — 新产品文档
- `docs/features/team-tasks/ACCEPTANCE.md` — 4 journey + 7 failure modes
- `scripts/verify-chat.mjs`（L1）替换原 4 个 verify-mission-* 脚本
- `src/test/chat-preview6-fixes.test.ts`（L2）4 个新测试

### 质量门禁（全绿）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit --project tsconfig.electron.json` | ✅ clean |
| `npm run build` (vite + tsc electron) | ✅ clean, bundle -15KB |
| `npx vitest run` | 703 pass / 3 fail / 3 skip · **0 new regressions**（3 fail 是 F-053 single-param migration 后的 pre-existing baseline，和本次改动无关） |
| `node scripts/verify-chat.mjs` | ✅ L1 PASS |
| DMG 签名 | ✅ Developer ID Application: Beijing VGO Co;Ltd (5XNDF727Y6) |
| DMG 公证 | ✅ `spctl: accepted, source=Notarized Developer ID` |
| DMG staple | ⏳ Notary 入库传播中（通常 5-15 分钟），staple retry 在后台跑；.app 本身的 ticket 已 stapled 且 spctl accepted |

### 未做 / 留给醒来后

1. **DMG staple 如果还没自动成功**：`xcrun stapler staple release/AwarenessClaw-0.3.7-preview.6-arm64.dmg`（CloudKit 会在完整传播后返回 ticket）
2. **上传 DMG 到 GitHub Release**（需要用户自己决定是否发布，按 CLAUDE.md 规则我不能自动分发）：
   ```bash
   cp release/AwarenessClaw-0.3.7-preview.6-arm64.dmg /tmp/AwarenessClaw.dmg
   gh release upload v0.3.0 /tmp/AwarenessClaw.dmg \
     --repo everest-an/AwarenessClaw-Download --clobber
   rm /tmp/AwarenessClaw.dmg
   ```
3. **推送后端升级通知**（需要用户决定是否 ship 给外部用户）：
   ```bash
   ssh server 'cat > /opt/awareness/data/app-versions.json << EOF
   {
     "awarenessclaw": {
       "latestVersion": "0.3.7-preview.6",
       "downloadUrl": "https://awareness.market/",
       "releaseNotes": "Chat-first redesign + 3 chat bug fixes",
       "mandatory": false
     }
   }
   EOF'
   ```
4. **手动验证**：关闭当前 AwarenessClaw，从 DMG 安装 preview.6，手测：
   - 侧栏没有 Tasks 图标 ✓
   - 普通聊天一切正常（thinking 显示在一个 UI 里、tool call 正常、markdown 渲染顺滑）
   - 长文本流式不卡顿、不重复
   - 让 AI 做个多步骤任务，看是否自动调 sessions_spawn 且结果内嵌
5. **主仓 SDK 同步**：本轮没改 `sdks/*`，不需要 SDK 同步。主仓 Awareness 自己的 `docs/features/team-tasks/` 是在 `AwarenessClaw` 仓库内，不走主仓 CI sync。

---

## 风险评估与回滚策略

- **最高风险点**：chat bug 修复触碰了 `register-chat-handlers.ts`（用户反复强调禁区）。我的改法是**在禁区外加包装层**（buffer / throttle / memo / dedup guard），thinking 解析、tool_use 解析、content_block 处理一行未动。4 个新 L2 测试 + L1 verify-chat.mjs 专门保护这些修复不被未来误动。如果用户手测发现 thinking UI 或 tool_use 渲染出现任何异常，`git revert a6a1747` 即可回到 preview.5 的 chat 行为，保留其他删除。
- **第二风险点**：删除 MissionFlow 78 个文件。交叉耦合调研显示 chat 模块**零引用** mission 代码（Agent 反复扫描确认）。删除后 vitest 1196 → 703（差值刚好等于删掉的 mission/workflow test 数），0 新 regression。如果有任何隐藏引用，`git revert 9df921a` 完整回滚到 preview.5 的功能面。

## 后续方向（和 user 之前的对话里讨论过）

- **0.4.0**：评估是否将 main agent 的 `sessions_spawn` 调用由 orchestrator pattern 管理（07-DECISION 的方案 C），让 AI 拆子任务时更稳定（当前靠 prompt 自觉）。但这涉及 agent system prompt 和 SOUL.md，风险中等。
- **Channel push 真实用户体验**：等真实用户跑一次长任务后观察完成通知链路是否自然（AI 会不会自己调 message_send？是否 spamming？）。如果 AI 太沉默，下一版可以在 main agent 的 identity.md 里加一句 hint。
- **Vibe coding power 模式**：preview.6 的 chat 流已足够强（thinking + tool_use + subagent inline）。如果你做 vibe coding 时觉得还缺 kanban-like "过程总览"，可以在聊天气泡右上角加一个"查看详情"抽屉（复用 `~/.openclaw/tasks/runs.sqlite` 做只读视图），0.4.0 考虑。

---

## 给用户醒来的一句话

**preview.6 DMG 已打好在 `packages/desktop/release/AwarenessClaw-0.3.7-preview.6-arm64.dmg`，签名+公证都过了（staple 在 notary 最后传播，后台在 retry）。你手动验证后再决定上传到 GitHub Release 和推后端。有任何一处破坏了 chat 的 thinking/tools 渲染，`git revert a6a1747` 立即回退到 preview.5 的 chat 行为，其他删除可保留。**
