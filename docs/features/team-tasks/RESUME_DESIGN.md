# Mission Flow · Resume / Durability Design

> **Status**: 设计稿 (未开工)
> **目标**：断网 / 关 OpenClaw Gateway / 关 AwarenessClaw 后，再打开能继续之前的 mission
> **作者**: 2026-04-18 session handoff
> **依赖**: 已完成的 F-Team-Tasks Phase 4+5 (mission-flow) + sweep handler (preview.5)

## 用户诉求（原话）

> 能够让任务持续进行也很重要，比如用户断网了，关闭 openclaw 了，下次打开能继续工作，
> 包括关闭我们的 awarenessclaw，这些都是心跳要有的

## 现状（preview.5 之后）

已有：
- **Runner idle timer**（15 min）— 单 step 内心跳，任何 delta/tool/final 重置
- **Mission 文件持久化** — `~/.awarenessclaw/missions/<id>/mission.json` + artifacts/ + MEMORY.md
- **Startup sweep** — app 启动时把上一 session 残留的 running/planning 自动标 failed
- **Runner hydrateFromDisk** — cancel/approveAndRun 时发现内存 Map 没 mission → 从磁盘 load

缺：
- ❌ App 重启后对活着的 Gateway session 重新订阅（真正的 resume）
- ❌ 断网 / 5xx 自动 retry
- ❌ AwarenessClaw 关闭也持续跑（daemon 化）
- ❌ Gateway 重启后 handoff

## 四级 Resume 方案

### L1 · re-attach live Gateway session（~3h 工）

**场景**：用户关 AwarenessClaw 后重新打开，Gateway 还在跑，session 还活着。

**思路**：
1. App 启动时，对 `status=running` 且 `startedAt < handlerStartedAt` 的 mission，**不要立即 sweep**（修改 sweep 规则）
2. 对每个这样的 mission：
   - 读 current step 的 `sessionKey` + `runId`
   - 调 `gateway.chatHistory(sessionKey)` 看是否还活着
   - 如果 history 末尾是 `final` → 说明 step 其实完成了 → writeArtifact + 继续 next step
   - 如果还在 active → 重新 `gateway.subscribe(sessionKey, handler)` → 接续 stream
   - 如果 session 404/gone → 降级为 sweep（mark failed）

**涉及文件**：
- `electron/mission/mission-runner.ts` — 加 `resumeMission(missionId)` 方法
- `electron/ipc/register-mission-handlers.ts` — 加 `mission:resume-pending` IPC + sweep 规则放宽
- `src/components/mission-flow/MissionFlowShell.tsx` — mount 先调 resume-pending 再调 sweep-stale
- `src/components/mission-flow/useMissionFlow.ts` — handle "resumed" stage 转换

**测试要求（L1-L5 都要）**：
- L2: runner.resumeMission(id) 能正确 re-subscribe + 处理 history 末尾的 3 种 state
- L3: chaos — gateway 返回 session-not-found / 5xx / timeout
- L4: 修改 e2e-mission-smoke.mjs 支持 resume — 跑一半 kill runner → 启新 runner → resume → mission:done

---

### L2 · auto-retry on transient error（~2h 工）

**场景**：断网 5 秒 / LLM provider 5xx / gateway timeout。

**思路**：
1. `mission-runner.ts::failStep` 里加 `retriable` 分类：
   - `network_error` / `timeout` / `5xx` → retriable
   - `permission_denied` / `context_overflow` / `invalid_plan` → not retriable
2. Retriable failure：backoff retry N 次（1s → 2s → 4s → 8s, max 3 次）而不是直接 mark failed
3. 每次 retry 前重新 `gateway.sendChat` 同样的 prompt
4. 超过 retry budget 才 mark failed

**涉及文件**：
- `electron/mission/mission-runner.ts` — 加 retry 状态机 + retry counter per step
- `electron/mission/types.ts` — step 加 `retries: number` 字段

**测试要求**：
- L2: network_error 第一次 retry 成功；3 次都失败 mark failed
- L3: context_overflow 不 retry（直接 fail）

---

### L3 · Daemon 化（关 AwarenessClaw 也继续跑）（~2-3 天工）

**场景**：用户点关闭 app 窗口 → 后台 daemon 继续跑 mission → 用户下次打开 app 能看到进度。

这是 **S2 里 04-STAGES.md 原计划的 Stage 2**（Runner daemon + Resume）。

**思路**：
1. 独立 Node 进程 `awarenessclaw-runner-daemon`（可以独立 npm package 或内嵌 Electron）
2. daemon 维护 MissionRunner 实例 + Gateway WS 长连接
3. Electron app 只是 "view"：通过 unix socket (macOS/Linux) / named pipe (Windows) 连 daemon 获取 state
4. App 关闭 daemon 不退；app 重开再连 daemon

**工程量大**：需要 OS-level autostart + IPC transport 改造 + crash recovery + daemon 升级策略。

**不建议在 preview 系列做**，留到 0.4.0。

---

### L4 · 关 OpenClaw Gateway 也能恢复（不可控）

**场景**：Gateway 崩了 / 用户手动 stop 了 gateway。

**限制**：Gateway session 在 Gateway 进程内存里，Gateway 死了 session 就丢了。唯一办法是等 Gateway 重启后，**让 AwarenessClaw 重新 spawn worker**（而不是 resume 原 session）。

**思路**：
1. Gateway down → `gateway.sendChat` 失败 → runner 标记 step `paused-gateway-down`
2. 用户/定期检测 Gateway 回来后，对 paused 的 mission 触发 "re-spawn from last-completed step"（重新从 artifact 拼 context 发给 worker）
3. **注意**：这不是真 resume，是"从最后 checkpoint 重来"，worker 可能产出不同结果

**工程量**：~4h，但需要验证 handoff context 质量。

---

## 推荐实施顺序

1. **Preview.6 = L1 + L2**（5h 工）— 解决 90% 用户场景
2. **0.3.8** = 打磨 + real E2E resume 脚本
3. **0.4.0** = L3（daemon 化）— 大版本
4. **0.4.x** = L4 (gateway 重启 handoff) — 按需

## 风险清单

1. **已 done step 的 artifact 如果是 partial write → 重启后 resume 读到残缺内容**
   - 缓解：file-layout 已用 `writeFileAtomic`（tmp + rename）
2. **Runner idle timer 在 L1 resume 后不会重置**
   - 缓解：resumeMission 里重新 `armStepIdleTimer`
3. **User 在 L1 resume 前已手动 cancel 的 mission 不能被 resume 复活**
   - 缓解：resume 只对 status in [running, planning] 且 completedAt unset 的执行

## 待决策

1. Preview.6 做 L1 + L2 还是只做 L1？
2. L1 需不需要 UI 提示"正在恢复之前的 mission..."？
3. Sweep 规则放宽后，僵尸 mission 何时真的标 failed？（handlerStartedAt - 30min 之前且不在 runner Map 里？）

---

**更新**：每次实现 L1/L2/L3 后在本文档打 ✅。
