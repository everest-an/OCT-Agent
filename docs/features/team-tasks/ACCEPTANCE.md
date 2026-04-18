# F-Team-Tasks · ACCEPTANCE (preview.6 rewrite)

> **前版**：preview.5 时代的 Mission Flow（TaskCenter tab + Kanban）
> **本版**：Chat-First Redesign — 用户只认 Chat，AI 自主 sessions_spawn

---

## Journey 1: 普通用户发任务，AI 自己完成

- **Given** 用户打开 AwarenessClaw，已连 Telegram 通道（默认配置），main agent 已配
- **When** 用户在 Chat 输入框输入 "帮我写一封邀请王总面谈的英文邮件" 并回车
- **Then**
  - 聊天流出现用户消息气泡
  - 1-3 秒内出现 AI 气泡（⏳ 状态），开始逐字流式输出
  - 若 AI 判断需要拆子任务：Tool Call `sessions_spawn` 渲染为气泡内嵌 section（`🔧 agentId · 任务描述` + 子输出）
  - 若 AI 判断不需要拆：就是普通的流式回复
  - 任务耗时 >30s 时，完成时 Telegram 收到一条 "🤖 AwarenessClaw 任务完成: ... " 通知
  - 气泡底部显示 ✅ 用时 X min Y sec
- **Assert**: `test/e2e/user-journeys/chat-sessions-spawn-happy.test.mjs`

## Journey 2: Power 用户做 vibe coding，能看过程

- **Given** 用户在 Chat 发 "帮我分析这个项目的 bug 然后修"
- **When** main agent 调用 `sessions_spawn` 启动 `coder` subagent
- **Then**
  - 气泡内嵌出现 "🔧 coder · 分析 bug" 折叠块，点击展开看实时 delta
  - subagent thinking / tool call 也在同一 trace panel 内（复用 ChatTracePanel）
  - **不跳转到任何新页面**（不进 TaskCenter，因为已删）
- **Assert**: `test/e2e/user-journeys/chat-subagent-inline.test.mjs`

## Journey 3: 关 app 再开，任务状态还在

- **Given** 用户发完任务，关闭 AwarenessClaw，此时 `task_runs` 有 2 条 running 记录
- **When** 用户 5 分钟后重新打开 AwarenessClaw
- **Then**
  - 进入原 Chat session（sessionKey 对上）
  - 对应 AI 气泡底部多一行："🔄 上次 2 个子任务还在进行，已重新订阅"
  - Gateway 未重启时继续订阅，完成时正常显示
  - Gateway 曾重启时显示 "⚠️ 子任务因 Gateway 重启已终止，可重新发送"（不自动重跑）
- **Assert**: `test/e2e/user-journeys/chat-resume-on-restart.test.mjs`

## Journey 4: 不打扰短对话

- **Given** 用户已连 Telegram
- **When** 用户发 "今天天气怎样"（短对话，AI 2 秒内回完）
- **Then**
  - 回复正常显示
  - **不**推 Telegram（因为耗时 <30s 阈值）
- **Assert**: L2 unit test in `chat-notify.test.ts`

---

## Failure Modes (L3)

### F1. Gateway 返回 5xx
- **If** 用户发消息时 Gateway /chat.send 返回 503
- **Then** UI 显示 "网络连接有问题，请稍后重试"（非 `undefined?code=undefined`）
- **Assert**: `src/test/chat-chaos.test.tsx::gateway 5xx shows friendly error`

### F2. Gateway 重启导致 subagent session 丢失
- **If** `gateway.subscribe(childSessionKey)` 返回 `session not found`
- **Then** 对应 tool_use section 显示 "⚠️ 子任务终止"，整体 mission 标为 paused（用户手动继续）
- **Assert**: `src/test/chat-chaos.test.tsx::child session lost`

### F3. Telegram push 失败
- **If** `openclaw message send` 返回 timeout / 401 / channel-not-found
- **Then** 聊天流正常结果显示 + 静默记日志（不打扰用户）
- **Assert**: `src/test/chat-notify-chaos.test.ts::all push failure modes`

### F4. SQLite 读失败（resume）
- **If** `~/.openclaw/tasks/runs.sqlite` 被锁 / 不存在 / corrupt
- **Then** chat 正常加载，不显示 resume banner（静默降级）
- **Assert**: `src/test/openclaw-sqlite.test.ts::graceful fallback`

### F5. 最后一轮重复输出（chat bug 修复）
- **If** Gateway 发两次 final 帧（第二次是 retry 补发的）
- **Then** UI 只显示一次结果
- **Assert**: `src/test/chat-dedup.test.ts::duplicate final frame ignored`

### F6. Thinking 散落（chat bug 修复）
- **If** Gateway 对同 messageId 发 3 个 thinking block，顺序乱序
- **Then** UI 只有一个 ChatTracePanel，按 sequence 号排序显示
- **Assert**: `src/test/chat-thinking-aggregation.test.ts::guarantees single trace panel`

### F7. ReactMarkdown 性能（chat bug 修复）
- **If** 流式输出 200 chars 的内容分 100 个 delta 到达
- **Then** ReactMarkdown 不对每个 chunk 重新 parse，总 re-render <= 5 次（实现上 throttle 节流+memo comparator）
- **Assert**: `src/test/chat-perf-memo.test.tsx::markdown renders <=5 times for 100 deltas`

---

## Definition of Done（preview.6）

8+3 条 + 本版新增：
1. [ ] 新按钮 / 菜单 → 手动验证过点击链路（因为本版无新按钮，只删不加，人工验一遍 Chat 主路径）
2. [ ] 新 `fetch(...)` → 目标端点在 main 仓已有（本版无新 fetch）
3. [ ] 新 externals → happy + 5xx + timeout 三组（✓ openclaw message send + task_runs sqlite）
4. [ ] `npm test` 全绿（含 chat dedup/aggregation/perf 三组新测试）
5. [ ] `npm run package:mac` 能出签名+公证 DMG
6. [ ] CHANGELOG 写"用户看到什么变化"（Mission Flow tab 消失、AI 可自主拆子任务、Telegram 通知）
7. [ ] 本地启 app 亲手走过 Journey 1 + 2
8. [ ] `scripts/dmg-smoke.sh` 过
9. [ ] **新增**：thinking / tool_use / content block 三个禁区字段在 grep `git diff` 中未出现（除加 dedup 层）
10. [ ] **新增**：Mission 相关 IPC channel name 不在 new code 中出现
11. [ ] **新增**：chat Journey 1 真 Gateway E2E pass（55s 内）
