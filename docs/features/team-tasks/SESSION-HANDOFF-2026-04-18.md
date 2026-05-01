# Session Handoff · 2026-04-18（preview.5 ship 后）

> **上一轮完成**：F-Team-Tasks Phase 4+5 落地 + 10 个 UI/UX hotfix → DMG 0.3.7-preview.5（含 sweep）
> **下一轮要做**：Mission Flow **Resume / Durability**（L1 + L2）

---

## 本轮（2026-04-17 ~ 04-18）已交付

### 新增功能
- Mission Flow Phase 4+5 全套落地（composer + plan preview + kanban streaming + history + IPC + L1~L5 测试金字塔）
- Startup sweep（残留僵尸 mission 自动标 failed）
- 真 E2E smoke script（`scripts/e2e-mission-smoke.mjs`）— 连真 Gateway 跑 3-step mission 55s 通过

### 修复 Bug（10 个）
| # | Bug | Fix |
|---|---|---|
| B1 | 两个输入框同屏 | 删 legacy goalInput + L1 防回归 |
| B2 | 切 tab Mission 状态丢失 | useMissionFlow localStorage 持久化 + mount restore |
| B3 | 过去 mission 看板看不到 | 新 MissionHistoryList 组件 |
| B4 | 所有 subtask 都分给 main agent | Planner prompt 加 `<RoutingRules>` |
| B5 | Planning / Running 无 Cancel/Stop 按钮 | 加 Cancel + red Stop |
| B6 | "思考中..." 永远没 streaming | React ref race 修掉 |
| B7 | 没显示默认模型 | Composer 加 🤖 Model: xxx |
| B8 | 出发/停止无反应（僵尸 mission） | Runner hydrateFromDisk |
| B9 | 已完成 step reopen 显示"没有输出内容" | 从 artifact 回读 + stripFrontmatter |
| B10 | 上次被强杀的 mission 永远显示"进行中" | startup sweep |

### 测试数字
- **375 mission-flow tests pass**（从初版 189 → +186 测试）
- **4 L1 static guards**（verify-mission-ipc / plan-schema / streaming-contract / no-legacy-goalinput）
- **真 Gateway E2E**: 54s 跑通，20 planner-delta + 82 step-delta，mission:done ✓
- 全 vitest：1192 pass / 6 baseline fail（和 mission flow 无关）/ 1 skip

### 已合并 (origin/main)
同事 8 个 commit 合并入 main：
- Windows regression fixes（daemon-watchdog / gateway-ws）
- openclaw.json 容错写入保护（safeWriteJsonFile）
- Chat direct-conversation mode
- Channel list cache invalidation
- 相关 tests

冲突只有 CHANGELOG.md（已手动 resolve 保留双方内容）。main.ts 自动合并成功。

### DMG 产出
- `release/AwarenessClaw-0.3.7-preview.5-arm64.dmg` — 含全部 10 个 bug fix + sweep + merge 后的同事代码
- 签名 + 公证 + staple 全部通过

### Commits（都已 push 到 `origin/main`）
```
98ce4dc Merge remote-tracking branch 'origin/main'
4e14110 feat(f-team-tasks): startup sweep kills zombie running missions
f702b2f fix: done-step shows artifact after reopen + wait indicator + real E2E smoke
94a32f6 fix: Approve/Stop buttons were no-op on zombie missions
b0e28ee fix: stop/cancel missions + planner streaming actually streams + model display
83175aa fix: Mission Flow UI hotfix · remove legacy goalInput + restore across tabs + multi-agent routing
b884cab feat: Mission Flow Phase 4 + L1-L5 pyramid · +130 tests
```

---

## 下一轮：Mission Flow Resume / Durability（**重大方向调整**）

**必读**：[RESUME_DESIGN.md](./RESUME_DESIGN.md) v2 — web search 调研后推翻了 v1 四级方案。

### 🔥 调研后的关键发现（用户质疑"openclaw 应该想到了吧？"之后做的）

**OpenClaw 2026.4.2 已有 TaskFlow durable substrate**：
- `openclaw flows list / show / recover / cancel` CLI
- Flow state 跨 Gateway 重启保留
- 详见 [RESUME_DESIGN.md Sources](./RESUME_DESIGN.md) 末尾 12 个官方/issue 链接

**我们当前 MissionRunner 完全没用它**（streaming-bridge.ts:74 用的是 chat.send）：
- S1-T0 方案 B 说 "TaskFlow + sessions_spawn + Streaming" 但实际代码没落地
- 是一个**并行的 TaskFlow 山寨实现** — 违反 CLAUDE.md 核心原则 #1 "套壳不复刻" + #2 "复用优先"

**OpenClaw `sessions_spawn` / `chat.send` 本身不 durable**（issue #62442 / #51814 / #50791）：
- UUID session keys，Gateway 重启就死
- 只 Discord 通道支持 `thread:true` durable session
- 走 chat.send 路径**无论如何做不到**"关 Gateway 恢复 mission"
- 真正的 durable 必须走 TaskFlow

### 新会话开工 prompt（直接粘贴用）

```
继续 OCT-Agent 的 F-Team-Tasks — 做 Mission Flow Resume / Durability。

**先读这 4 个文件（必须，按顺序）**：
1. OCT-Agent/docs/features/team-tasks/SESSION-HANDOFF-2026-04-18.md — 上轮完整进度（本文件）
2. OCT-Agent/docs/features/team-tasks/RESUME_DESIGN.md — v2 设计（含 OpenClaw 调研结论 + Sources 列表）
3. OCT-Agent/docs/features/team-tasks/07-DECISION-LOBSTER-VS-TASKFLOW.md — S1 原始拍板（TaskFlow 为目标，但代码没落地）
4. OCT-Agent/packages/desktop/electron/mission/mission-runner.ts — 现状主文件（用 chat.send，不是 TaskFlow）

**重要背景（上一会话 web search 结论，别重复调研）**：
- OpenClaw 2026.4.2 已提供 TaskFlow durable state + `openclaw flows recover` CLI
- 我们的 MissionRunner 用 chat.send 自己做了一套 — 是技术债，违反"套壳不复刻"
- Gateway restart session 恢复是 OpenClaw upstream 已知未修（issue #62442），我们不可能自己修
- sessions_spawn UUID session 在 Gateway 重启后必死（除 Discord thread:true 例外）
- 详细 sources：RESUME_DESIGN.md 末尾 12 个链接

**本轮第一阶段（30 min 必做，阶段 0 · 反向工程）**：
目标：搞清 OpenClaw Flows API 能不能满足我们"多 agent 异质分工"的需求。

产出：docs/features/team-tasks/OPENCLAW_FLOWS_API.md，回答：
1. Gateway WS 有哪些 flow 相关 RPC（tasks_flow_spawn / flows.create / flows.recover / flows.list / flows.cancel 等）？格式？
2. Flow 里的 subtask 能否指定不同 agentId（我们需要 designer/coder/tester）？
3. Flow 的 streaming delta 格式 vs 我们现在用的 event:chat delta — 兼容吗？
4. `openclaw flows recover <id>` 的语义：从最后 checkpoint 继续？重跑 failed task？
5. Flow 持久化存储在哪（~/.openclaw/flows/？SQLite？）？

手段：
- 读 ~/.npm-global/lib/node_modules/openclaw/dist/（或找本地 openclaw 安装），grep "flows" "TaskFlow" "tasks_flow_spawn"
- `openclaw gateway --log-level debug` 在一个 shell，另一个 shell 跑 `openclaw flows list` / `openclaw flows show <id>`，抓 WS 帧日志
- auxclawdbot/taskflow 仓库可能有参考

**阶段 0 结论二选一**：

**方案 A（激进但正确 — Flows API 能支持异质 agent 分工的话）**：
- 重写 mission-runner.ts 用 tasks_flow_spawn / flows.*（~1-2 天）
- 每个 subtask 变 OpenClaw task（durable）
- 删掉自己的 sweep / hydrateFromDisk / idle timer — OpenClaw 管
- mission.json 降级为 UI 缓存，真实状态从 `openclaw flows list` 拉
- resume = `openclaw flows recover <id>`
- ~375 个测试改 mock 适配
- 收益：关 Gateway 重启也能继续，上游免费提供 durable
- 风险：Flows API 可能不够灵活（多 agent 分配），需阶段 0 验证

**方案 B（保守 — 如果 Flows API 不灵活回退）**：
- 保留 chat.send 架构，只修最大用户痛点
- L1 · 重启时 re-attach live Gateway session（~3h）：
  - mission-runner.ts::resumeMission(id) 用 gateway.chatHistory + subscribe 接续
  - 仅解决 "OCT-Agent 重启、Gateway 活着" 80% 场景
  - 明确限制：Gateway 重启 session 就死，我们修不了（upstream issue）
- L2 · network/5xx/timeout 自动 backoff retry 3 次（~2h）
- **必记录技术债**：docs/prd/active-features.md 加一条 "0.4.0 必须迁 TaskFlow"

**硬性要求（必守，user 反复强调）**：
1. **充分 L1-L5 测试** — 每文件配 test
   - L2 单元：runner resume / retry 所有路径
   - L3 chaos：gateway 404 / 5xx / timeout / session-not-found / delta 乱序
   - L4 真 E2E：改 scripts/e2e-mission-smoke.mjs 加 resume 场景 — kill runner mid-flow → new runner → resume → mission:done
   - L5 Stryker 季度（不阻塞 preview.6）
2. **真 Gateway E2E 必跑** — 每次 commit 前
3. **verify:mission-all 必过** + **build 必过**
4. **不造新轮子** — 自己实现前先确认上游没做过

**验证 preview.5 代码还活着（新会话第一步）**：
cd /Users/edwinhao/Awareness/OCT-Agent/packages/desktop
npx vitest run src/test/mission-*.test.ts src/test/mission-*.test.tsx
# 预期 375 tests pass
npm run verify:mission-all
# 预期 4 L1 PASS
node scripts/e2e-mission-smoke.mjs
# 预期 ~55s mission:done（需 openclaw gateway 在跑）

**避坑清单（上轮血泪）**：
- React ref race — activeIdRef 同步更新 + isCurrent 放宽 null 时也接受
- Runner hydrateFromDisk — 操作旧 mission 前必须 hydrate，否则 get/cancel/approve 静默失败
- writeMission 等 file-layout 函数 import 不能漏（曾因此 debug 半小时）
- Agent id 必须严格匹配 openclaw.json 的 agents.list[].id（LLM 幻觉 id 会静默失败）
- 不要 sleep 轮询 — 用 Monitor tool
- Gateway sendChat 返回 runId 不等于 agent 真在跑（可能是 agent 不存在 / tools 缺失 → LLM 从不响应 → 我们 15 min idle timer 才 fail）

**决定方案前要问用户的 4 个问题（写在 OPENCLAW_FLOWS_API.md 末尾）**：
1. 阶段 0 反向工程结果：Flows API 支持我们的多 agent 编排吗？
2. 如果支持，接受重写 mission-runner 的风险（375 测试改 mock）吗？
3. mission.json 数据迁移：保留兼容读 vs 0.4.0 breaking？
4. Gateway 重启 session 丢失（issue #62442 upstream 限制）—— 要不要 UI 提示用户"刚重启过 Gateway 请重发此 mission"？

**验收标准**：
- DMG 0.3.7-preview.6：用户关 OCT-Agent 重开，上次 running mission 能看到真实进度（方案 A 或 B 都 OK）
- 可选（方案 B 才有）：断网 10s 单 step 不 fail
- vitest + 4 L1 + build + real E2E + new resume E2E 全绿

中间不要停，疑惑记在 RESUME_DESIGN.md 末尾 "待决策" 一起问。
```

### 已知未决（下一轮前要定的）

1. **阶段 0 反向工程的结果**：Flows API 到底能不能支持 designer/coder/tester 异质分工？如果只能单 agentId flow 就只能走方案 B
2. **方案 A 的 TaskFlow 迁移风险**：375 个测试全要改 mock — 接受吗？
3. **数据兼容**：mission.json 现存 `~/.awarenessclaw/missions/` 要不要保留兼容读（用户看历史）还是 0.4.0 breaking
4. **Gateway 重启后 subagent session 丢失（issue #62442）**：upstream 限制，我们不做，但要不要 UI 提示用户"如果 Gateway 刚重启过，请重发这个 mission"？

---

## 对照用户硬要求

| 用户原话 | 本轮处理 | 下轮 handoff |
|---|---|---|
| "充分测试 L1-L5" | 375 + 4 L1 + real E2E | 继续要求 |
| "傻瓜化 3 按钮" | composer + ←返回 + ⏹停止 + "开新任务" | 保持 |
| "不造轮子" | ⚠️ **违反了** — MissionRunner 是 TaskFlow 的山寨实现（chat.send 而非 tasks_flow_spawn） | **下轮修复**：阶段 0 调研 + 方案 A 迁 TaskFlow |
| "Streaming 一等民" | planner/step delta 全链路 + UI elapsed 计时 | 保持，Flows streaming 格式待 verify |
| "不能卡死" | idle timer 15min + sweep + hydrate + UI warmup 提示 | resume 新增：re-attach 不卡死 |
| "持续进行（断网/关 openclaw/关 awarenessclaw）" | 上轮只做 sweep（标 failed）；真 resume 待阶段 0 决 A/B | **下轮**：方案 A 根治 / 方案 B 只补 "OCT-Agent 重启" 场景 |
| "一定要确保功能都可用" | 真 E2E 55s 跑通证明基础 OK | 每次 merge 前真 E2E + real resume test 必跑 |
| "openclaw 应该已经想到了吧" | ⚠️ **上轮漏查** — 这轮 web search 了 TaskFlow + sessions_spawn 限制 | 新 prompt + RESUME_DESIGN v2 已含全部调研 |
