# Changelog

## [0.4.8] - 2026-05-01

### Fixed - Windows first-run memory module self-repair

- Fixed first-run setup getting stuck at "Installing memory module" when a previous attempt left an empty `~/.openclaw/extensions/openclaw-memory` directory.
- Setup now cleans invalid partial plugin installs before retrying, reinstalls Awareness Memory, and keeps recent installer errors in the UI message for diagnosis.
- Awareness Memory is now explicitly selected via `plugins.slots.memory = "openclaw-memory"` and `memory-core` is disabled so OpenClaw 2026.4.x does not silently keep the default memory plugin active.
- Patched Windows plugin daemon startup compatibility by rewriting bare `spawn("npx", ...)` calls to use `npx.cmd` on Windows.
- Doctor can now auto-fix installed Awareness Memory plugins that still use the old bare `npx` spawn pattern.

### Verified

- Ran targeted setup/config/doctor regression tests: `setup-handlers`, `openclaw-capabilities`, `config-sync`, and `doctor`.
- Confirmed `npm run build` succeeds.
- Verified locally that OpenClaw loads `Awareness Memory` after repair.

## [0.4.7] - 2026-04-27

### Fixed — 桌面端洞察提取闭环（重大修复）

- **问题**：本地 daemon 在 `awareness_record(action='remember')` 响应中返回 `_extraction_instruction`，期望 host LLM 据此提取知识卡片并通过 `awareness_record(action='submit_insights', insights={...})` 回传。OCT-Agent 桌面端长期**完全丢弃这个字段** —— 用户聊天 → 事件入库 → 但 0 张知识卡片入库，向量召回质量永远停在 turn_brief 级别
- **修复路径**：在 `electron/ipc/awareness-memory-utils.ts` 加入"待办提取中继"。收到 daemon 响应后把指令落盘到 `~/.awareness-claw/pending-extraction.json`，下一轮 chat 启动时由 `tryBuildDesktopMemoryBootstrapSection` 读取并注入到 LLM 的 bootstrap context 里，提示 LLM 在回应用户之前先调 `submit_insights`
- **设计**：one-shot（读后删）+ 30 分钟 TTL（防陈旧），与今天云端 backend 的 `submit_insights` 修复联动 —— LLM 回传 JSON 走的就是云端新加的 dispatch 路径
- **测试**：6 个新单测覆盖写入/读取/TTL/格式异常/section 渲染（`src/test/awareness-pending-extraction.test.ts`）

### Changed — 跟随云端最新 daemon

- 启动时自动拉取的 `@awareness-sdk/local@latest` 现在解析到 0.11.4，新增 `submit_insights` 防御性 `content=<json>` fallback，向后兼容旧客户端的提示词

## [0.4.6] - 2026-04-21 (Windows)

### Fixed — 新 Agent Market 中的 agent 导致"Invalid session ID"错误（关键修复）

- **问题**：用户从 Agent Market 下载新 agent（如 meal-planner）后创建聊天，收到 `Error: Invalid session ID: agent:meal-planner:webchat:session-xxx`
- **真实根因**：Gateway 返回的"Invalid session ID"错误是通过 **event 事件**而不是异常（exception）传递的，所以之前的 catch 块无法捕获
- **完整修复**：
  - 在 `chatEventHandler` 的 `state === 'error'` 事件处理中主动检测非主 agent 的"Invalid session ID"错误
  - 如果检测到，**抛异常** 而不是调用 resolve，使其进入 catch 块触发 CLI fallback
  - 主进程随后的 catch 块识别该错误为非主 agent 的无效 session，自动切换到 CLI fallback 模式
  - CLI 会读取最新的 `~/.openclaw/openclaw.json`，包含新下载的 agent 配置
- **用户体验**：完全无感知，消息后台自动重试，显示状态提示"The selected agent is not yet available via Gateway. Using local CLI mode..."
- **诊断**：详细控制台日志追踪 4 个关键点：agent 验证、Gateway chatSend 尝试、错误分类、CLI fallback 触发
- **测试**：46 个单元测试全绿，包含专门的 invalid-agent + marketplace-agent recovery 测试用例

### Fixed — 打包版本强制走 prod,不再受本地 override 污染

- **Packaged exe 现在完全忽略 env `AWARENESS_API_BASE` 和 `~/.awareness/marketplace-config.json`**,硬锁到 `https://awareness.market/api/v1`。之前这两个 override 在 dev 和打包版都生效,后果是开发者电脑上留的测试 override 会"偷偷"跟着 exe 发给用户(F-063 0.4.2-0.4.5 踩过的坑)
- 启动时在 devtools console 打印 `[marketplace] apiBase=... (source: ...)`,用户一开 DevTools 就能验证请求到底发到哪台服务器,以后再出现"我提交没到 prod"的问题可以秒排查
- 新增 3 组 L1 contract test (`marketplace-api-timeouts.test.ts`) 锁死:DEFAULT_API_BASE = prod、packaged 模式禁用 override、启动 log 必须有 `[marketplace] apiBase=` 字样。以后任何 commit 把这三条规则破坏了 CI 直接挂

## [0.4.5] - 2026-04-21 (内部, 未发布)

### Fixed — 分享 submit 12 秒死超时(真实用户 bug)

- 0.4.4 的分享表单在生产环境偶发"timeout after 12000ms"错误——因为 submit 的 HTTP 超时全局写死 12s,而生产真实延迟常到 10-25s(LLM 校验 + DB 写 + 限流检查)。直接提高到 **45s**,不改 GET 端点的 12s。
- 错误信息不再直接抛原始技术文本("timeout after 12000ms" / "ECONNREFUSED")给用户。主进程把底层错误归一到 `errorCode`:`timeout` / `network` / `rate_limit` / `validation` / `unknown`,渲染端按 i18n 显示"服务器响应超时,请 30 秒后刷新查看"之类的友好文案
- 新增 L3 contract test(`marketplace-api-timeouts.test.ts`)锁死 `SUBMIT_TIMEOUT_MS ≥ 30000`,防止后人改动时无意间把超时调回 12s 导致同 bug 再现
- 新增 3 组 UI chaos test:timeout / network / rate-limit 下错误信息都不能泄露原始技术文本,必须显示友好 i18n 消息

## [0.4.4] - 2026-04-21 (内部, 未发布)

### Fixed — 分享表单 UX bug

- **分类现在是真的下拉框**(之前是自由文本输入,用户根本选不到 academic / data / design 等 20 个真实分类,只能瞎打字)。补全了后端接受的全部 20 个 category + community + other
- **分类 dropdown 21 项全部 i18n**:academic / career / community / data / design / education / engineering / finance / game-dev / lifestyle / marketing / paid-media / product / productivity / project-mgmt / sales / spatial / specialized / support / wellness / writing / other,中英文独立显示
- **整个分享表单 30+ 文案走 i18n**:标题、所有字段标签、错误提示、按钮、slow-server 提示、tier 选项、联系方式 placeholder,彻底告别硬编码中文
- 提交中途点击模态背景不再会把对话框关掉(之前会丢失 in-flight 请求)
- 按 `Esc` 关闭模态;`role="dialog"` + `aria-modal="true"` 让屏幕阅读器认得出
- 表单字段级 `aria-invalid` + 红色边框高亮:slug 写错会在 slug 输入框上标红,用户一眼就知道哪里错,不用再去页面底部读错误文本
- 必填字段用 `*` 号、可选字段明确标 `(optional)`,避免"联系方式"被误以为必填
- 小屏(<768px)下表单自动堆成单列(grid-cols-1 md:grid-cols-2)

### Added — 多一层 L3 chaos 测试

- 新增"提交中点击背景不应关闭模态"回归测试

## [0.4.3] - 2026-04-21 (内部, 未发布)

### Changed — 分享 Agent 改走无损结构化链路

- **点"分享我的 Agent"现在把 SOUL / AGENTS / VIBE / MEMORY / USER / HEARTBEAT / BOOT / BOOTSTRAP 8 个文件以独立字段发到集市**,不再先合成单一 markdown 再让后端启发式切分。切分过程会丢细节、偶尔把字段分错桶,这一版彻底堵上
- 审核后上架路径同样直接把 8 个字段落到 agent 表,别人安装时 workspace 文件结构与原作者 100% 一致

### Added — 提交审核时的慢服务器 UX

- 按钮现在有旋转 spinner + 实时秒数(`提交中... 8s`),不再是死转圈
- 等待超过 6 秒会弹黄色提示"服务器正在处理,生产环境偶尔需要 8-12 秒",不会让用户误以为卡死
- 提交失败后表单字段全部保留,按钮变"重试提交",不用重填 slug/描述/联系方式
- 失败原因在 alert 框里带边框突出显示,下方小字提示"表单已保留,修复后可直接重试"

### Added — 防回归测试(L1 + L2 + L3)

- **L1 静态守卫**(`scripts/verify-marketplace.mjs`):8 个结构化字段在 ShareAgentForm / preload / 后端 Pydantic 三处强制同名,任何一处漏加 CI 会挂
- **L2 后端集成**(`backend/tests/marketplace/test_admin_routes.py::TestStructuredFieldsRoundTrip`):submit 带 8 字段 → admin approve → 公开 catalog GET 回来字段非 null 且 byte-identical。堵住 "字段在路上丢了没人知道" 的哑 bug
- **L3 客户端 chaos**(`src/test/share-agent-form-chaos.test.tsx`):happy / HTTP 500 / 网络断 / 慢服务器 / 无效 slug 五组,验证 UX 在任一失败模式下都可恢复

## [0.4.2] - 2026-04-20 (macOS)

### Added — 集市 agent 覆盖完整 OpenClaw workspace 9 文件

- BOOT.md(网关重启 checklist)+ BOOTSTRAP.md(新用户一次性 Q&A)现在能从集市 seed。安装时如果集市 agent 定义了这两个文件,installer 会按需写入 `~/.openclaw/workspace-<slug>/`
- 修复:189 个上架 agent 的 `vibe` 覆盖率从 6% 涨到 100%(agency-agents 把 vibe 放在 frontmatter,之前漏读)
- Admin UI 表单重构成 3 段:📘 必填本体 (SOUL + AGENTS + Vibe) / 📗 集市 seed (HEARTBEAT + BOOT + BOOTSTRAP) / 🔒 隐私区默认隐藏 (MEMORY + USER),减少 admin 误填终端用户隐私数据

## [0.4.1] - 2026-04-20 (macOS)

### Changed — Agent 集市走 per-file 结构化字段

- 后端每个 agent 现在把 SOUL.md / AGENTS.md / IDENTITY vibe / MEMORY.md /
  USER.md / HEARTBEAT.md 存成独立字段。admin 编辑时按文件填写,避免了
  "用户不按约定写 ## Identity 标题" 导致的安装分桶错乱
- 桌面端安装流程:优先用后端传的结构化字段直接落盘 → workspace 文件;
  只有老版本后端不传时才回退到关键词启发式
- 可选的 MEMORY.md / USER.md / HEARTBEAT.md 只在 agent 真有内容时才写入
  用户 workspace,不再无脑创建空文件
- 100% round-trip: 分享的 agent 装到别人机器上,workspace 文件结构跟
  原作者的完全一致

### Added — 合成的单 markdown 保留用于 Claude sub-agent 导出

- 后端维护一个 `markdown` 字段,每次写入时自动从结构化字段 compose 出来
- 未来要把 agent 导出给 Claude sub-agent / Cursor subagent,后端直接返回
  这个字段即可,不需要客户端再拼

## [0.4.0] - 2026-04-20 (macOS)

### Added — Agent Marketplace 正式版上线

- **189 个精选 agent**:16 个原创 + 173 个来自 [agency-agents](https://github.com/msitarzewski/agency-agents) (MIT License)
- **5 个分类 tab**: ⭐ 推荐 / 📚 日常工作 / 💼 专业场景 / 🔧 工程开发 / 全部
- **新增中国市场 agent**: 小红书 / 抖音 / B 站 / 快手 / 知乎 / 微博 / 微信小程序 / 微信公众号 / 百度 SEO / 直播电商 / 私域运营 / 电商运营 / 中国市场本地化
- **Admin 可编辑**: 官方 agent 可通过 `/admin/marketplace` 直接改 DB,秒级生效,不需要重新部署桌面端
- **社区投稿**: 集市右上角"分享我的 Agent" → admin 审核队列 → 批准后上架
- **多宿主架构就绪**: 每个 agent 可声明 compat(openclaw / claude-code / hermes / codex / cursor),桌面端当前只装 openclaw 的,其它 host 留待未来支持
- **默认连接生产**: DMG 默认连 `https://awareness.market`,无需额外配置

### Changed — 上游 backend 迁到 Postgres

- 不再是文件存储(previews 都是),admin 改数据实时持久化
- Install count 从真实用户安装累加,不会被 seed 覆盖
