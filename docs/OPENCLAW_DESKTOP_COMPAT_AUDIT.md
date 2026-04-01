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

执行时间：`待执行`

环境：

- OS：macOS
- OpenClaw：`OpenClaw 2026.3.31 (213a704)`
- Desktop build：已通过

### 8.1 Startup / Lifecycle

- [ ] 应用启动
  - 结果：`待填写`
  - 观察：`待填写`
- [ ] 托盘与窗口行为
  - 结果：`待填写`
  - 观察：`待填写`
- [ ] 二次启动
  - 结果：`待填写`
  - 观察：`待填写`
- [ ] 退出行为
  - 结果：`待填写`
  - 观察：`待填写`

### 8.2 Channel Setup

- [ ] WeChat / URL QR 流
  - 结果：`待填写`
  - stdout 特征：`待填写`
  - Desktop 状态：`待填写`
- [ ] Signal / deep-link 流
  - 结果：`待填写`
  - deep-link 行为：`待填写`
  - 失败文案：`待填写`
- [ ] WhatsApp / ASCII QR 流
  - 结果：`待填写`
  - QR 展示情况：`待填写`
  - 是否丢行/截断：`待填写`
- [ ] add-only 流
  - 结果：`待填写`
  - add 后是否直接成功：`待填写`
  - bind 是否执行：`待填写`
- [ ] add-then-login 流
  - 结果：`待填写`
  - add 失败是否阻断：`待填写`
  - login 是否继续：`待填写`
- [ ] 超时与失败路径
  - 结果：`待填写`
  - QR 超时文案：`待填写`
  - 非 QR 超时文案：`待填写`

### 8.3 Chat / Gateway

- [ ] Gateway 连接
  - 结果：`待填写`
  - 观察：`待填写`
- [ ] thinking / tool 状态流
  - 结果：`待填写`
  - 事件顺序：`待填写`
- [ ] CLI fallback
  - 结果：`待填写`
  - fallback 表现：`待填写`
- [ ] chat abort
  - 结果：`待填写`
  - 子进程残留情况：`待填写`

### 8.4 汇总结论

- 通过项：`待填写`
- 失败项：`待填写`
- 新发现风险：`待填写`
- 是否允许继续拆分高风险区：`待填写（yes / no）`

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