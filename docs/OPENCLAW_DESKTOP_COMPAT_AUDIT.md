# AwarenessClaw Desktop x OpenClaw 结合审计

最后更新：2026-04-01
适用范围：`AwarenessClaw/packages/desktop/electron/main.ts` 及其拆分后的主进程模块

## 1. 审计目的

这份文档记录 Desktop 主进程重构期间，和本机 OpenClaw 真实行为之间已经核对过的结合点、未完成的高风险点、以及本地环境噪音。

目标不是“写一个理想说明书”，而是避免在多轮拆分后忘记哪些地方已经验证过、哪些地方仍然只是代码层假设。

## 2. 当前基线

- 本机 OpenClaw 版本：`OpenClaw 2026.3.31 (213a704)`
- 当前验证机器：macOS
- 当前验证方式：CLI 实测 + desktop build + channel 定向测试

## 3. 已验证项

### 3.1 CLI 输出兼容

- `openclaw --version` 可正常返回版本号，未出现额外包装格式变化
- `openclaw dashboard --no-open` 仍返回 `Dashboard URL: http://127.0.0.1:18789/#token=...` 这一格式，桌面端现有解析逻辑仍兼容
- `openclaw channels add --help` 中的 channel 枚举和 flags 仍可被 channel registry 解析逻辑覆盖
- `openclaw channels login --help` 当前仍支持 `--channel` 与 `--verbose`，和 desktop 的 `channel:setup` 登录命令一致
- `openclaw plugins install --help` 当前仍接受 `plugins install <path-or-spec-or-plugin>`，和 desktop 的插件安装步骤一致
- `openclaw cron --help` 当前主文案使用 `rm`
- `openclaw cron remove --help` 仍可执行，说明桌面端对旧别名的兼容假设仍成立

### 3.2 重构后的回归验证

- `packages/desktop` 的 `npm run build` 已通过
- channel 定向测试已通过：`src/test/channels.test.tsx`、`src/test/channels-status.test.tsx`
- 2026-04-01 新增纯转换测试：`src/test/channel-session-transform.test.ts`

### 3.3 已完成且已重新核对的拆分区块

- `register-channel-config-handlers.ts`
  - 已合并 teammate 远端改动：managed runtime OpenClaw dist 发现逻辑
  - async fallback 现在同时支持 managed runtime 和 `npm root -g`
- `register-channel-list-handlers.ts`
  - `channel:list-configured`
  - `channel:list-supported`
- `register-channel-session-handlers.ts`
  - `channel:sessions`
  - `channel:history`
  - `channel:reply`
- `channel-login-flow.ts` + `register-channel-setup-handlers.ts`
  - 已完成 code-level copy/paste 拆分
  - 目前只完成 CLI 帮助输出兼容核对与 build 级验证
  - 尚未完成真实 QR / deep-link / add-only / add-then-login 全链路实机验证

## 4. 当前未完成的高风险验证

以下部分还不能因为“build 过了”就视为和本机 OpenClaw 结合完全正确：

- `channel:setup`
  - 风险：涉及 `openclaw plugins install`、`channels add`、`channels login --verbose` 的真实链路
  - 风险点：二维码登录时序、stdout 解析、浏览器跳转、账号已存在时的重试路径
  - 当前状态：代码已拆分为独立模块，但仍应视为“高风险待实测”，不能因为 build 通过就视为完全验证
- `chat:send`
  - 风险：依赖 Gateway WebSocket 事件序列、thinking/tool_use/tool_result 流式转发、CLI fallback
  - 风险点：本机 gateway 状态、session 复用、stream 结束时机
- app lifecycle / tray / startup
  - 风险：依赖 Electron 生命周期和本机 PATH、managed runtime、daemon 状态之间的组合行为

## 5. 已知本地环境噪音

以下告警在当前机器上是稳定复现的，但不是这轮重构新增的问题：

- `plugins.entries.signal`: duplicate plugin id detected; bundled plugin will be overridden by config plugin
- `plugins.entries.qwen-portal-auth`: plugin not found; stale config entry ignored

处理原则：

- 这些 warning 目前应记录为“本地环境噪音”，不要误判成重构回归
- 若后续出现新的 CLI 失败，需要先和这两条已知 warning 区分开

## 6. 后续审计规则

每次继续拆分 `main.ts` 中任何仍与 OpenClaw 强耦合的区块时，至少补做以下两类记录：

1. 代码验证
   - build 是否通过
   - 是否有对应定向测试
2. 真实结合验证
   - 至少记录一条本机 OpenClaw CLI 或 Gateway 真实行为核对结果

如果某次拆分只做了 build，没有做真实结合核对，必须在本文件中明确写成“未实测”，不能默认当成已验证。

## 7. 当前停止线

从 2026-04-01 当前状态起，以下区块默认进入“停止继续拆分”状态，除非先满足对应验证门槛：

- `chat:send` / `chat:abort`
  - 原因：强依赖 Gateway WebSocket 事件序列、thinking/tool_use/tool_result 流式语义、CLI fallback
  - 继续拆分前门槛：至少补一轮本机 Gateway 实测，确认消息流、tool 状态流、fallback 行为都可观察
- app lifecycle / tray / startup
  - 原因：强依赖 Electron 生命周期、登录启动、窗口可见性、PATH 注入、managed runtime 状态
  - 继续拆分前门槛：至少明确一份手工冒烟清单并执行一轮
- `channel:setup` 后续细拆
  - 当前允许状态：保持现有两个模块形态，不再继续碎拆
  - 原因：虽然已拆为 `channel-login-flow.ts` 与 `register-channel-setup-handlers.ts`，但真实 QR / deep-link / add-only / add-then-login 仍未全链路实测

当前结论：

- 可以继续做“审计、补测试、补文档、补实测记录”
- 不应该继续做新的高风险代码拆分，直到上述门槛被满足

对应的最低手工验证门槛见 [OPENCLAW_DESKTOP_SMOKE_CHECKLIST.md](OPENCLAW_DESKTOP_SMOKE_CHECKLIST.md)。

## 8. 第一轮 Smoke Run 执行稿

执行时间：`2026-04-02 13:10`（自动化子集）

环境：

- OS：macOS
- OpenClaw：`OpenClaw 2026.4.1 (da64a97)`
- Desktop commit：`786faf09e0b086ffed344fda5120973f917b4d92`
- Desktop build：已通过（`cd AwarenessClaw/packages/desktop && npm run build`）
- Chat tests：已通过（`npm test -- src/test/dashboard.test.tsx src/test/register-chat-handlers.test.ts`，20/20）
- 自动化证据：`/tmp/openclaw-deep-smoke-20260402/*.json`

### 8.1 Startup / Lifecycle

- [ ] 应用启动
  - 结果：`未执行（需人工 GUI）`
  - 观察：`本轮仅完成 build 与 gateway 事件流自动化；未打开 Desktop 窗口做白屏/崩溃核对`
- [ ] 托盘与窗口行为
  - 结果：`未执行（需人工 GUI）`
  - 观察：`未覆盖 close -> hide -> restore`
- [ ] 二次启动
  - 结果：`未执行（需人工 GUI）`
  - 观察：`未覆盖 single instance 唤起`
- [ ] 退出行为
  - 结果：`未执行（需人工 GUI）`
  - 观察：`未覆盖僵尸进程检查`

### 8.2 Channel Setup

- [ ] WeChat / URL QR 流
  - 结果：`未执行（需人工 GUI / 真实通道）`
  - stdout 特征：`待填写`
  - Desktop 状态：`待填写`
- [ ] Signal / deep-link 流
  - 结果：`未执行（需人工 GUI / 系统协议）`
  - deep-link 行为：`待填写`
  - 失败文案：`待填写`
- [ ] WhatsApp / ASCII QR 流
  - 结果：`未执行（需人工 GUI / 真实通道）`
  - QR 展示情况：`待填写`
  - 是否丢行/截断：`待填写`
- [ ] add-only 流
  - 结果：`未执行（需人工 GUI / 真实通道）`
  - add 后是否直接成功：`待填写`
  - bind 是否执行：`待填写`
- [ ] add-then-login 流
  - 结果：`未执行（需人工 GUI / 真实通道）`
  - add 失败是否阻断：`待填写`
  - login 是否继续：`待填写`
- [ ] 超时与失败路径
  - 结果：`未执行（需人工 GUI / 真实通道）`
  - QR 超时文案：`待填写`
  - 非 QR 超时文案：`待填写`

### 8.3 Chat / Gateway

- [ ] Gateway 连接
  - 结果：`部分通过`
  - 观察：`test-gateway-event-stream.mjs` 在 8 个 Round1 自动化场景里都拿到了 health / agent.lifecycle.start / chat 事件，说明 Desktop -> Gateway WebSocket 主路径已连通；但所有聊天请求最终都落在同一上游错误：LLM request failed: network connection error.`
- [ ] thinking / tool 状态流
  - 结果：`阻塞`
  - 事件顺序：`只观察到 health -> agent.lifecycle.start -> tick -> agent.lifecycle.error -> chat(state=error)`
- [ ] CLI fallback
  - 结果：`未覆盖`
  - fallback 表现：`本轮未刻意制造 WS 失败；当前失败发生在 Gateway 连通后的 LLM 上游阶段，不足以证明 CLI fallback 可用`
- [ ] chat abort
  - 结果：`未覆盖`
  - 子进程残留情况：`待填写`

### 8.4 汇总结论

- 通过项：`Desktop build 通过；dashboard/register-chat-handlers 测试 20/20 通过；Gateway 健康探测与 WS 事件流连通`
- 失败项：`R1-03 exec approval、R1-04 thinking、R1-05 multi-agent、R1-06 skill invocation、R1-07 memory write/recall、R1-08 workspace、R1-10 recovery 这 8 个自动化场景全部在 chat 结束前收到同一错误：LLM request failed: network connection error。未进入 tool_call / approval / tool_result / final text 阶段`
- 新发现风险：`当前最大阻塞不是 Desktop 前端状态机，而是上游 LLM 请求层不稳定；在该问题排除前，deep smoke 无法判断 Browser / Skill / Memory / 多 Agent / 项目目录这些高阶链路是真坏还是被统一短路`
- 是否允许继续拆分高风险区：`no`

## 9. 深测结论（2026-04-01）

以下结论来自两条真实深测，而不是代码静态推断：

### 9.1 OpenClaw 当前真实工作区不是 Desktop 里选中的项目目录

证据：

- CLI 深测：
  - `openclaw agent --session-id cx-cli-workspace-test --message "Use the exec tool to run pwd and answer with the working directory only." --thinking low --timeout 60 --json`
  - 返回的 `systemPromptReport.workspaceDir` 是 `/Users/edwinhao/.openclaw/workspace`
- Gateway 深测：
  - `test-gateway-event-stream.mjs` 捕获到 `exec.approval.requested`
  - 其中 `request.cwd` 明确是 `/Users/edwinhao/.openclaw/workspace`

结论：

- Desktop 当前传入的 `workspacePath` 只是在 prompt 中作为上下文提示
- 它没有成为 OpenClaw Gateway / agent 的真实执行 cwd
- `workspace:write-file` 仍固定写入 `~/.openclaw/workspace`

因此，当前 UI 中“AI file edits will run inside this local project folder”这一层语义不能当成已验证事实。

### 9.2 thinking / tool 内容当前受 OpenClaw 审批流阻断

证据：

- 当前本机 `tools.alsoAllow` 为：
  - `awareness_recall`
  - `awareness_record`
  - `awareness_lookup`
  - `awareness_perception`
  - `awareness_init`
  - `awareness_get_agent_prompt`
- 不包含 `exec`
- Gateway 深测中，模型确实尝试调用 `exec pwd`
- 但事件流停在 `exec.approval.requested`，随后直接进入生命周期结束 / `chat final`
- CLI 深测返回的是 `/approve ... allow-once`，说明当前真实行为是“等待审批”而不是“自动执行工具”

结论：

- Desktop 现在并不是完全收不到工具事件
- 更准确地说，当前常见深测路径会先被 OpenClaw 的审批流截断
- 在未放行 `exec` 或未处理审批事件前，`tool_result` 和最终工具执行结果不会稳定出现

### 9.3 当前对 Desktop 的直接影响

- 不应把“项目目录已真正接管写文件/执行上下文”当成已完成能力
- 不应把“UI 不显示工具内容”简单归因于前端问题，至少有一部分是 OpenClaw 审批流导致工具没有真正执行完
- 如果要继续验证 `thinking/tool` 完整展示，下一步应优先处理以下二选一：
  1. 临时放行 `exec`，再重跑深测，确认是否能拿到完整 `tool_use/tool_result`
  2. 先让 Desktop 把 `exec.approval.requested` 这种审批事件展示出来，而不是只显示最终空回答或审批命令

## 10. 二次深测结论（2026-04-02）

### 10.1 Desktop 默认权限已补到仓库可控路径

本轮已把 Desktop 侧默认权限接入两条主链路：

- `packages/desktop/electron/main.ts`
  - `applyAwarenessPluginConfig()`
  - `sanitizeAwarenessPluginConfig()`
- `packages/desktop/src/lib/store.ts`
  - `syncToOpenClaw()`

当前默认最小 allowlist 为：

- `exec`
- `awareness_init`
- `awareness_recall`
- `awareness_lookup`
- `awareness_record`
- `awareness_get_agent_prompt`

设计意图：

- 保留 `tools.profile = coding`
- 只额外打通 Desktop 开箱即用最常见的 shell 和记忆工具
- 不把权限一次性放太宽，避免触发 `alsoAllow > 20` 的安全告警

### 10.2 真实 OpenClaw 深测显示：`alsoAllow` 不是唯一审批开关

实测步骤：

1. 先把本机 `~/.openclaw/openclaw.json` 备份并追加 `exec` 到 `tools.alsoAllow`
2. 复跑 CLI 深测：
   - `openclaw agent --session-id cx-cli-workspace-test-2 --message "Use the exec tool to run pwd and answer with the working directory only." --thinking low --timeout 60 --json`
3. 复跑 Gateway 深测：
   - `node packages/desktop/scripts/test-gateway-event-stream.mjs "You must call at least one tool before answering. Use the exec tool to run 'pwd' and then answer with the working directory in one sentence."`

结果：

- CLI 仍然连续返回 `/approve ... allow-once`
- Gateway 仍然发出 `exec.approval.requested`
- 事件中明确包含：
  - `security: "allowlist"`
  - `ask: "on-miss"`
  - `request.command: "pwd"`
  - `request.cwd: "/Users/edwinhao/.openclaw/workspace"`

结论：

- 即使 `exec` 已进入 `tools.alsoAllow`，当前本机 OpenClaw Gateway 仍有第二层宿主审批策略
- 在 AwarenessClaw 仓库当前可见代码和 `openclaw.json` 中，没有找到 Desktop 还能直接关闭的对应字段
- 因此“默认权限”在当前阶段的正确边界应定义为：
  - Desktop 负责把最小可用 allowlist 写好
  - Desktop chat UI 负责把 `*.approval.requested` 事件明确展示给用户
  - 不应继续假设“只改 `alsoAllow` 就能完全免审批”

### 10.3 对产品判断的更新

- Desktop 现在已经具备承接审批流的前端状态展示能力，这是必须项，不再是可选优化
- 当前真实宿主行为下，仍然可能有工具需要用户确认，这和“开箱即用”并不矛盾；关键是不能静默卡住
- 后续如果要进一步追求“默认免审批”，必须先拿到 OpenClaw 宿主第二层审批策略的正式配置口径，否则不应在 Desktop 里伪造承诺

## 11. 三次复测结论（2026-04-02，网络恢复后）

### 11.1 之前的统一 network error 更像是瞬时网络抖动，不是持久配置错误

本轮继续排查时，直接验证了三条链路：

1. 直接请求 `qwen-portal` 的 `/models` 接口，返回 `200 OK`
2. `openclaw agent --message "Reply with exactly OK." --thinking low --json` 可正常返回 `OK`
3. 重新执行 `packages/desktop/scripts/test-gateway-event-stream.mjs "Reply with exactly OK."`，最终收到 `chat(state=final)`，正文为 `OK`

结论：

- `qwen-portal` provider 本身不是持续性坏配置
- `qwen-max-latest` 也不是绝对不可用，因为 CLI 与 Gateway 基础请求在网络恢复后都可成功
- 第 8 节里那一批 `LLM request failed: network connection error.` 更接近 2026-04-02 当时的真实外网抖动，而不是 Desktop 特有缺陷

### 11.2 thinking streaming 与基础 agent 路径当前可用

复测 prompt：

- `Think briefly first, then answer in steps: how to connect an Electron chat app to a Gateway event stream?`
- `Who are you now? Reply with current agent name and responsibility only.`

结果：

- thinking 场景事件统计为：`health * 2`、`agent:lifecycle * 2`、`agent:assistant * 259`、`chat:delta * 115`、`chat:final * 1`
- 最终收到完整正文，说明 Gateway 主路径下的 assistant streaming 与最终落盘恢复正常
- agent 身份问答也收到 `chat(state=final)`，说明基础 agent 返回链路已恢复

这意味着：

- 之前第 8 节里因统一 network error 被判定为 fail 的基础 chat / thinking / agent 场景，不能继续简单归因为 Desktop 回归
- 至少在当前网络恢复后的环境里，这三类链路都可以跑通

### 11.3 当前仍然稳定存在的问题：exec approval 事件后直接 final 空消息

复测 prompt：

- `Use the exec tool to run pwd and reply with only the working directory.`

事件序列：

- `health`
- `agent:lifecycle(start)`
- `exec.approval.requested`
- `presence`
- `health`
- `health`
- `agent:lifecycle(end)`
- `chat(state=final)`

关键现象：

- 本轮不再出现统一的 `network connection error`
- 但在出现 `exec.approval.requested` 后，没有看到后续 `tool_result`、审批继续执行、或任何最终正文
- 最终直接落到 `chat(state=final)` 且正文为空

结论：

- 当前最值得继续跟进的真实兼容问题，已经从“统一上游网络错误”收敛为“审批流出现后，Desktop / Gateway 脚本路径没有继续执行到可见结果”
- 这与第 10.2 节的判断一致：`alsoAllow` 不是唯一审批开关；即使基础聊天恢复，审批链路仍然是高风险区

### 11.4 当前停止线更新

- `chat` 基础链路：恢复为 `可用`
- `thinking` streaming：恢复为 `可用`
- `multi-agent` 基线回答：恢复为 `可用`
- `exec approval` 继续执行：仍为 `阻塞`
- `CLI fallback`、`chat abort`、`channel setup`、`startup/lifecycle GUI`：仍未完成实测

因此当前结论更新为：

- 不再把“统一 network error”视为当前主阻塞
- 但高风险区继续拆分结论仍保持 `no`，因为审批流闭环和其余最小手工门槛仍未完成

### 11.5 approval 闭环自动化复测结果：仍不能视为已完全对齐 OpenClaw chat

本轮继续做了一次更接近闭环的验证：

- 读取 renderer 侧实现，确认 `Approve once` 实际不是走独立 UI 魔法，而是再次调用 `chatSend('/approve <id> allow-once')`
- 相关代码位于 `src/pages/Dashboard.tsx` 的 `handleApproveTool()` / `runChatRequest()`
- 对应前端测试已覆盖该设计路径：`src/test/dashboard.test.tsx` 中 `keeps approval requests actionable instead of showing no response`

随后做了两条真实 Gateway 自动化尝试：

1. 自动捕获 `exec.approval.requested` 后发送 `/approve ...`
2. 使用更强提示强制模型必须调用 `exec`

结果：

- 第一条尝试里，模型没有进入 approval，而是直接返回 `NO`
- 第二条尝试里，模型也没有稳定发出 `exec.approval.requested`，而是直接返回一段最终文本，内容是 `exec` 受 allowlist miss 限制，无法执行 `pwd`

结论：

- 当前 approval/tool 路径还不够稳定，至少自动化实测下不能稳定收敛到 `approval.requested -> /approve -> tool_result -> final text`
- 因此现在仍不能把 Desktop 判断为“已经符合 OpenClaw chat 的全部功能”
- 更准确的状态是：基础聊天、thinking、基础 agent 回复已恢复；但 approval / tool / 更高阶能力仍未完成充分实证闭环

### 11.6 三个高阶场景复测结果：Memory / Workspace / Browser 仍未闭环

在网络恢复后，又补跑了 3 个最关键的高阶场景：

#### Memory

- 写入 prompt：`Please remember this exact decision: use WebSocket as primary path and do not default to CLI fallback.`
- 结果：收到最终文本，明确声称“已记录成功”
- 但紧接着召回 prompt：`What decision did we just make?`
- 结果：模型回答“当前没有看到刚刚做出的具体决定”，并只提到了更旧的 `MEMORY.md` 测试记录

判断：

- 这说明“记忆写入成功”的最终话术，当前不能直接视为真实 recall 闭环证据
- 至少在这一轮自动化复测里，Memory 的 `write -> new session recall` 还没有闭住

#### Project Folder / Workspace

更新说明（2026-04-02，B-010 之后）：

- 本节原始结论基于修复前行为，彼时 `workspacePath` 确实更像 prompt 注入
- 在 B-010 修复后，Desktop 已改为把用户选择目录写入 `openclaw.json` 的 `agents.defaults.workspace`，并在切换后重启 Gateway
- 因此此处“未接入真实 cwd / workspace”的历史结论只能作为修复前背景，不能再作为当前最终判断

- prompt：`Inspect package.json in the current project directory and list the scripts.`
- 结果：模型最终回答当前项目目录里不存在 `package.json`

结合第 9.1 节此前结论（修复前）：

- Desktop 传入的 `workspacePath` 仍更像 prompt 注入，而不是真正接管 OpenClaw 的执行 cwd
- 因此 Project Folder 语义目前仍不能视为已经和 OpenClaw chat 的真实工作目录行为完全对齐

#### Browser

- prompt：`Open Google and search for today's latest news, then give me 5 summaries with sources.`
- 结果：模型最终明确返回当前缺少 web search 所需 API key，并提示需要配置 `BRAVE_API_KEY` / `openclaw configure --section web`

判断：

- 这不是 Desktop 独有回归，更像运行环境前置条件未满足
- 但从“是否已符合 OpenClaw chat 全部功能”的标准看，当前 Browser 能力仍不能算已完成，因为环境本身还没具备可执行前提

### 11.7 当前总判断

截至本轮排查，最准确的产品判断是：

- 已恢复并可用：基础 chat、Gateway 主路径、thinking streaming、基础 agent 回复
- 未形成实证闭环：approval / tool 继续执行、Memory 写入后新会话召回、Project Folder 真实 cwd 接管
- 受环境前置条件阻塞：Browser（缺少 web search API key）

因此：

- 当前不能把 AwarenessClaw Desktop 视为“已经符合 OpenClaw chat 的全部功能”
- 只能说它已经接近基础聊天能力对齐，但在 approval、memory、workspace、browser 这些高阶链路上仍存在未闭环缺口

### 11.8 本轮测试闭环结论（可作为当前最终判定）

这轮自动化与代码核对已经把当前可测范围基本跑完，可以形成一个明确闭环：

| 能力 | 当前状态 | 结论类型 | 根因归类 |
|------|----------|----------|----------|
| 基础 chat | 通过 | 已闭环 | Gateway 主路径恢复正常 |
| thinking streaming | 通过 | 已闭环 | 网络恢复后 `chat:delta` / `chat:final` 正常 |
| 基础 agent 回复 | 通过 | 已闭环 | agent 路径恢复正常 |
| Browser | 未通过 | 已定性 | 环境缺失 `BRAVE_API_KEY`，不是 Desktop 独有回归 |
| Memory write -> recall | 未通过 | 已定性 | 本地文件已写入，但 recall 未命中新写内容；更像索引/检索策略/session 作用域缺口 |
| Project Folder / workspace cwd | 修复后待人工复核 | 已修复代码 + 待 UI deep smoke | Desktop 已改为同步 `agents.defaults.workspace` 并重启 Gateway；需以 UI 路径复核真实文件写入是否落在所选目录 |
| approval / tool continue | 未通过 | 已定性 | 设计链路存在，但真实 Gateway 自动化下未稳定闭合；更像宿主审批策略 + 模型分支共同作用 |

因此截至本节：

- 如果标准是“Desktop 是否已经具备 OpenClaw chat 的基础聊天能力”，答案是 `yes`
- 如果标准是“Desktop 是否已经符合 OpenClaw chat 的全部关键功能并完成高阶链路闭环”，答案目前仍是 `no`，但 `Project Folder / workspace cwd` 已不应继续按“仅 prompt 注入”归因，需以修复后的 UI deep smoke 结果为准

这就是当前阶段的最终判定；后续继续测试，应视为针对具体缺口的专项修复验证，而不是再重复做一轮全量可用性判断。

## 12. Windows 复测结论（2026-04-04，channel routing 修复后）

### 12.1 当前环境与安装态

本轮在 Windows 上补了一次更贴近发版交付物的复测，直接核对已安装桌面端与本机 OpenClaw 运行态：

- OS：Windows
- Desktop commit：`e1955e2`
- 已安装桌面版本：`0.1.0`
- OpenClaw：`OpenClaw 2026.4.2 (d74a122)`
- daemon health：`http://127.0.0.1:37800/healthz -> status=ok`

同时确认当前桌面端进程已在运行，说明本轮安装包至少满足：

- 已安装 EXE 可正常启动
- 当前不会出现“安装成功但主程序起不来”的阻塞问题

### 12.2 Channel routing 后端证据已恢复为正常

本轮直接验证了两条最关键的 routing 证据：

1. `openclaw agents bindings --json`
2. `openclaw channels list`

结果如下：

- bindings JSON 已可正常解析，且明确包含：
  - `main <- whatsapp/default`
  - `main <- telegram`
- `openclaw channels list` 已能列出：
  - `Telegram default: configured, token=config, enabled`
  - `WhatsApp default: linked, enabled`

这意味着：

- 之前 Settings 里 `Channel routing` 发黄时，对应的底层证据链现在已经恢复
- 至少从 OpenClaw CLI 真实返回看，Telegram / WhatsApp 的“已配置 + 已绑定”状态都能被读出来
- 本轮 doctor 的 Windows `NUL` 重定向修复与插件依赖自愈修复，没有再把 routing 检查卡死在旧的失败模式上

### 12.3 仍存在的残余风险

虽然 `openclaw channels list` 已经能输出有效结果，但在有用输出之后仍然跟着一条：

- `AbortError: This operation was aborted`

当前判断：

- 这更像 OpenClaw 上游 CLI / Gateway 的收尾不稳定，而不是 Desktop 当前 routing 状态再次损坏
- 因为同一命令已经先给出了有效 channel 列表，说明主链路信息并没有丢
- 但它仍应保留为已知风险，不能假装 runtime 已经完全无噪音

### 12.4 本轮可形成的发布前判断

截至 2026-04-04 这轮 Windows 复测，可以成立的判断是：

- 已确认：安装包 `0.1.0` 可安装、可启动，桌面进程正在运行
- 已确认：OpenClaw bindings 可读，Telegram / WhatsApp routing 后端证据正常
- 已确认：local daemon 正常，Awareness memory 插件已初始化
- 未确认：Settings 页黄色告警是否在 UI 层已经同步消失；这一项仍需要一次人工打开桌面端后的目视复核
- 未确认：startup/lifecycle GUI、真实 channel setup UI、chat 高阶链路，这些仍属于需要人工 deep smoke 的区块

因此本轮最准确的结论是：

- `channel routing` 的底层运行时问题，当前可以视为已修复并有 CLI 证据支撑
- 但发版前如果要给出“Windows 已完全通过桌面端验收”的结论，仍需要补最后一次 GUI 目视复核