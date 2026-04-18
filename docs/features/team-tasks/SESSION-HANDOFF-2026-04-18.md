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

## 下一轮：Mission Flow Resume / Durability

**必读文档**：`docs/features/team-tasks/RESUME_DESIGN.md`（四级方案 + 推荐顺序）

### 推荐下一轮 scope：L1 + L2（~5h 工）

**L1 · Re-attach live Gateway session**（~3h）
- 用户关 AwarenessClaw 重开 → 运行中 mission 能接续 stream
- 修改 sweep 规则：不要立即 sweep running mission，先尝试 resume

**L2 · Auto-retry on transient error**（~2h）
- 断网 / 5xx / timeout → backoff retry 3 次
- Context overflow 不 retry（直接 fail）

### 新会话开工 prompt（直接粘贴用）

```
继续 AwarenessClaw 的 F-Team-Tasks — 实施 Mission Flow Resume / Durability 第一阶段（L1 + L2）。

**先读这 3 个文件（必须）**：
1. AwarenessClaw/docs/features/team-tasks/SESSION-HANDOFF-2026-04-18.md — 上轮进度
2. AwarenessClaw/docs/features/team-tasks/RESUME_DESIGN.md — 本轮设计稿（四级方案）
3. AwarenessClaw/packages/desktop/electron/mission/mission-runner.ts — 要改的主文件

**本轮目标**（只做 L1 + L2，别做 L3 daemon 化）：

L1 · Re-attach live Gateway session（~3h）：
- mission-runner.ts 加 public 方法 resumeMission(missionId)
  - 读磁盘 mission.json
  - 对 running step 读 sessionKey/runId → gateway.chatHistory(sessionKey) 看是否 alive
  - Alive + 末尾 final → 按 final 处理（writeArtifact + spawnNextStep）
  - Alive + 还在 active → gateway.subscribe(sessionKey, handler) 接续 stream + 重置 idle timer
  - Dead (404/gone) → fallthrough to sweep（markFailed）
- register-mission-handlers.ts 加 IPC mission:resume-pending，返回 {resumed: [...ids], sweptToo: [...]}
- MissionFlowShell mount effect：先调 resume-pending，再调 sweep-stale
- 修改 sweep 规则：允许 running 状态留着给 resume 处理（仅 paused > X min 才 sweep）

L2 · Auto-retry on transient error（~2h）：
- mission-runner.ts::failStep 增加 retriable 判断（network_error / timeout / gateway-5xx）
- Retriable 走 retry-with-backoff 1s/2s/4s（max 3 次）
- 不 retriable（permission_denied / context_overflow / invalid_plan）直接 mark failed
- step 类型加 retries: number 字段

**硬性要求**（用户反复强调）：
1. 充分 L1-L5 测试 — 每写一个文件配 test
   - L2: resumeMission 3 种 history state / retry 成功 / retry 耗尽
   - L3 chaos: gateway 404 / 5xx / timeout / delta 乱序
   - L4: 更新 scripts/e2e-mission-smoke.mjs 加 resume 场景（kill runner 中途 → new runner → resume → done）
   - L5: Stryker mutation 跑 mission-runner / streaming-bridge
2. 真 E2E 必须跑 — 不是只 mock。用 scripts/e2e-mission-smoke.mjs 起真 Gateway 跑
3. 每改一次提交前 npm run verify:mission-all 全绿 + build 过

**验证 preview.5 代码还活着**（新会话第一步）：
cd /Users/edwinhao/Awareness/AwarenessClaw/packages/desktop
npx vitest run src/test/mission-*.test.ts src/test/mission-*.test.tsx
# 预期 375 tests pass
npm run verify:mission-all
# 预期 4 L1 PASS

**不能卡死**（上轮踩的坑）：
- React ref race — activeIdRef 同步更新 + isCurrent 放宽 null
- Runner hydrateFromDisk — cancel/approveAndRun 前确保 Map 有
- writeMission / 其他 file-layout 函数 import 不漏
- Agent id 必须严格匹配 openclaw.json list

完了打 DMG 0.3.7-preview.6 给我。中间不要停，全做完一起告诉我。
```

### 已知未决（下一轮可以决策）

1. **resume 前要不要 UI 提示**"正在恢复 3 个 mission..."？建议加，防用户一脸懵
2. **Gateway 死了怎么办**（L4 场景）？L1+L2 不解决这个，等 0.4.x
3. **Daemon 化（L3）**：2-3 天工程，留到 0.4.0
4. **L4 Playwright-style 真 UI E2E**：node:test + real Gateway 已够用，Playwright 可能过度

---

## 对照用户硬要求

| 用户原话 | 本轮处理 | 下轮 handoff |
|---|---|---|
| "充分测试 L1-L5" | 375 + 4 L1 + real E2E | 继续要求 |
| "傻瓜化 3 按钮" | composer + ←返回 + ⏹停止 + "开新任务" | 保持 |
| "不造轮子" | 100% 用 OpenClaw TaskFlow + subagents | 保持 |
| "Streaming 一等民" | planner/step delta 全链路 + UI elapsed 计时 | 保持 |
| "不能卡死" | idle timer 15min + sweep + hydrate + UI warmup 提示 | resume 新增：re-attach 也不卡死 |
| "持续进行（断网/关 openclaw/关 awarenessclaw）" | sweep 是第一步（标 failed）；真 resume 在 RESUME_DESIGN.md L1-L4 | **下轮做 L1+L2** |
| "一定要确保功能都可用" | 真 E2E 55s 跑通证明基础 OK | 每次 merge 前真 E2E 必跑 |
