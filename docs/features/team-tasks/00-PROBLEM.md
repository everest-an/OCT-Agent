# 00 · Problem — 为什么当前的 Team Tasks 不够用

> **更新日期**：2026-04-17
> **调研依据**：探索代码 + 真实运行观察

## 用户原话诉求

> "现在团队任务功能，你觉得实现的完整吗？可靠吗？"
> "我觉得要能持续干活的团队任务才行，必须能够给他一个任务能够完整的做完，要利用 openclaw 的完整能力"
> "最好也把这个功能落地成可以持续执行的多个文档"

**核心诉求**：给一个高层目标（"做博客系统"），**不管多长时间、多少 agent 接力、关 app 再开，都能真的把这个任务完整做完**，而不是前端点几下假装跑起来。

## 现状 · 4 大真缺口

### 缺口 1 · Agent 间无 context 传递（最致命）

**证据**：
- [packages/desktop/src/lib/mission-store.ts:24](../../../packages/desktop/src/lib/mission-store.ts#L24) `MissionStep.instruction` 字段存在但创建时**永远是空串**
- [packages/desktop/electron/ipc/register-workflow-handlers.ts:59](../../../packages/desktop/electron/ipc/register-workflow-handlers.ts#L59) `buildSubagentSpawnCommand` 只拼 `/subagents spawn <agentId> "<task>"`，**不传前置 step 的输出**
- Main agent 靠 `ws.chatHistory(sessionKey)` 同步读取全部历史来"推理" sub-agent 之间的关系

**表现**：step0 的 Planner 说"用 Next.js + Tailwind + Prisma"，step1 的 Developer 启动后**完全不知道**这个决定，可能选了 Vue + Bootstrap。

**原因**：Mission 把多 step 当成"main agent 协调的黑盒"，没有显式的 artifact/context 接力协议。

### 缺口 2 · 15 分钟 idle timeout 杀长任务

**证据**：
- [register-workflow-handlers.ts:910](../../../packages/desktop/electron/ipc/register-workflow-handlers.ts#L910) `IDLE_TIMEOUT_MS = 15 * 60 * 1000`
- CLI fallback 默认 `timeoutSeconds = 120`（2 分钟）
- **没有恢复机制**：进程死就死，mission 转 `failed`，用户只能删了重来

**表现**：
- "写 100 个单元测试" 跑到 60min → 被杀
- 跑 `npm install` 在慢网络 5min 无输出 → 被杀（但装包实际还在后台）
- `prisma migrate deploy` 拉 schema 超时 → 被杀

**原因**：idle timeout 为了防僵死，值偏保守；没有区分"真死" vs "在等外部 IO"。

### 缺口 3 · App 关闭即死，无 resume

**证据**：
- [register-workflow-handlers.ts:750](../../../packages/desktop/electron/ipc/register-workflow-handlers.ts#L750) `activeMissions` 是内存 `Map`
- [packages/desktop/src/lib/mission-store.ts:34-47](../../../packages/desktop/src/lib/mission-store.ts#L34-L47) Mission schema **没有** `sessionKey` / `runId` / `resumeToken` 字段
- localStorage 里只存元数据（status / steps / result），不存 spawn metadata
- [TaskCenter.tsx:66](../../../packages/desktop/src/pages/TaskCenter.tsx#L66) 启动时调 `missionListActive()`，后端返回空即标 `failed`

**表现**：
- 用户开始一个长任务 → 关笔记本盖子休眠 → 打开 → 任务全 `failed`，前面 1 小时白跑
- Electron 主进程 crash（OOM / 信号）→ 所有 running mission 丢失
- 升级 OCT-Agent 版本必然中断 mission

**原因**：产品把 mission 设计成"一次性 session bound"，不是"长生命周期 job"。

### 缺口 4 · 没接 Awareness memory，agent 是"一次性失忆人"

**证据**：
- mission 执行链路中**完全没有**调用 `awareness_recall` / `awareness_record`（在 `register-workflow-handlers.ts` 中 grep `awareness_` 命中 0 次）
- sub-agent 启动前不查"这个用户之前做过类似的事吗"
- sub-agent 完成后不把"我踩过这个坑"存进记忆

**表现**：
- 同一个用户同一个项目，第二次跑"做博客系统" → agent 从零开始问"用什么技术栈？"，上次选的 Next.js + Prisma 已经被遗忘
- 踩过的坑（"记得在 Apple Silicon 上 sharp 要用 arm64 版本"）每次都要重新踩

**原因**：OCT-Agent 的定位是 "OpenClaw + Awareness Memory"，但 mission 这条线没接通 memory。

## 次要缺口（S4 再处理）

- 没有三级重试（失败一次直接放弃）
- 没有人类介入通道（Slack/Telegram/飞书 通知）
- 没有并行 step（step3 和 step4 没依赖也只能顺序跑）
- 没有 context compression（多轮后 prompt 爆炸）
- 错误只有 `"interrupted or detached"` 这种泛化文案

## 产品 Scope（必做 / 可以 / 不做）

### S1-S3 必做

- ✅ Planner 能把高层目标拆解为 3-8 个 subtask（有序 + 有 deliverable）
- ✅ 每个 step 启动前能读到：前置 artifacts + 共享 MEMORY.md + Awareness recall
- ✅ 每个 step 结束后：写 artifacts/T{n}.md + append MEMORY.md + awareness_record
- ✅ 任务文件持久化在 `~/.awarenessclaw/missions/<id>/`，关 app 不丢
- ✅ Electron 关了也能继续跑（Runner daemon 化）
- ✅ 重开 app 能看到真实进度（resume）
- ✅ 失败 3 级重试（同 agent → 换 agent → 通知人类）

### S4 可以

- ⚠️ 并行 step（DAG 执行）
- ⚠️ 长任务 checkpoint（step 内断点续传）
- ⚠️ 通过 OpenClaw channel 叫人
- ⚠️ Context compression（超长 prompt 自动摘要）

### 明确不做（避免过度工程）

- ❌ 跨设备 mission 同步（单机持久化就够，跨设备等真有需求再说）
- ❌ 多用户协作（一个用户一个 memory_id）
- ❌ mission 之间依赖 / 触发（先做好单个 mission）
- ❌ GUI 直接编辑 plan.md（用户改就用系统编辑器，不做内嵌 editor）

## 不在本 feature 处理的问题

- Qwen 模型污染（在 `TASKS.md` P1 回归修复）
- Signal / WhatsApp 插件路径清理（同上）
- Gateway Windows 计划任务缺失（另一条线）

## 下一步

读 [01-DESIGN.md](./01-DESIGN.md) 看整体架构。
