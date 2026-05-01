# OCT-Agent Desktop 深度 Smoke Test 计划

最后更新：2026-04-02
适用范围：OCT-Agent Desktop 与本机 OpenClaw / Gateway / 插件 / Skills / Channels / Memory 的端到端回归验证

## 1. 目的

这份文档不是最小冒烟门槛，而是一份偏发布前、重构后、兼容性排查用的深度 smoke test 计划。

它主要回答 4 个问题：

1. Desktop chat 和 OpenClaw chat 的关键行为是否对齐。
2. Browser / Tool / Skill / Memory / Channel 等复杂链路是否真的可用，而不是只有 UI 或配置。
3. 当前桌面端是否会在高风险链路上退化成“无响应”“空结果”“只显示最终文本，看不到工具状态”。
4. 当 Gateway、权限、审批、插件、skill、通道配置出现异常时，Desktop 是否给出可操作反馈。

## 2. 使用方式

建议把这份深度 smoke plan 用在以下场景：

- 发布前
- 桌面 chat / Gateway / Skills / Memory / Channels 大改后
- `main.ts` 或其 IPC 模块继续拆分前
- 用户已经反馈“功能看起来在，但真实用不了”时

如果只是做最低门槛验证，仍使用 [OPENCLAW_DESKTOP_SMOKE_CHECKLIST.md](OPENCLAW_DESKTOP_SMOKE_CHECKLIST.md)。

如果你要直接开始第一轮执行，优先使用 [OPENCLAW_DESKTOP_DEEP_SMOKE_RUN_ROUND1_2026-04-02.md](OPENCLAW_DESKTOP_DEEP_SMOKE_RUN_ROUND1_2026-04-02.md)。该文档把全量 deep smoke plan 压缩成 10 个最高价值场景，适合第一轮快速排雷。

## 3. 执行前提

### 3.1 环境基线

- Desktop build 可通过：`cd OCT-Agent/packages/desktop && npm run build`
- 桌面 chat 相关测试通过：
  - `npm test -- src/test/dashboard.test.tsx src/test/register-chat-handlers.test.ts`
- 本机已安装 OpenClaw
- 本机 Gateway 可启动
- 已至少有一个可用模型
- 若要覆盖 skill / memory / channel 场景，对应插件或配置需要事先可用

### 3.2 建议记录的信息

每次跑深测前先记录：

- OS
- Desktop commit
- OpenClaw 版本
- `~/.openclaw/openclaw.json` 中关键配置差异
- 当前权限 preset
- 当前是否启用 `exec`
- 当前已安装的 skills
- 当前是否接入 Awareness memory plugin

### 3.3 建议证据

每个失败项尽量保留：

- 屏幕录屏或截图
- DevTools console 中的 `chat:debug` / gateway 事件
- Desktop 界面文案
- OpenClaw Dashboard 或 CLI 侧可见状态

## 4. 结果分级

### Blocker

- 无法发送消息
- Gateway 无法连接且无可操作错误
- Browser / Tool / Skill / Memory 任一核心链路完全不可用
- 审批、thinking、tool 状态流与真实执行严重脱节

### Major

- 功能可用，但结果明显与 OpenClaw 原生 chat 不一致
- tool 已执行但 Desktop 显示 `No response`
- skill 已安装但 chat 无法触发
- 记忆或频道消息只部分工作

### Minor

- 状态文案不准确
- thinking 折叠状态不理想
- 某些 UI 细节与原生行为不同，但不影响任务完成

## 5. 执行原则

### 5.1 每个场景都记录 4 项

- 输入：你给 Desktop 的 prompt 或操作
- 预期：应该发生什么
- 实际：真实发生了什么
- 结论：pass / fail / flaky

### 5.2 对比原则

如果你想验证“Desktop chat 是否和 OpenClaw chat 没偏差”，同一条 prompt 最好跑两遍：

- 一遍在 Desktop chat
- 一遍在 OpenClaw 原生 chat / agent CLI / dashboard

重点比较：

- 是否走到同一个 agent
- 是否触发相同工具
- 是否出现相同审批
- 是否能拿到同等级别的最终结果
- 是否出现 Desktop 独有的 `No response`、卡死、thinking 消失、tool 结果丢失

## 6. Smoke Matrix

## A. Startup / Runtime Baseline

### A-01 应用启动

步骤：

- 启动 Desktop

预期：

- 主窗口正常打开
- 无白屏
- 无主进程崩溃
- 若本地 Gateway 可用，不应阻塞主窗口出现

### A-02 二次启动 / 单实例

步骤：

- Desktop 已运行时再次启动

预期：

- 不产生第二个主实例
- 原窗口被唤起或聚焦

### A-03 关闭 / 恢复 / 退出

步骤：

- 关闭窗口
- 再次恢复
- 再正常退出

预期：

- macOS 下关闭窗口应隐藏，不应直接退出
- 恢复后无重复实例
- 退出后不残留明显僵尸进程

## B. Chat Parity Baseline

### B-01 最简单文本问答

Prompt：

- `你好，回答一句话：你现在在线吗？`

预期：

- 必须返回正常文本
- 不应出现 `No response`

### B-02 长文本 Markdown 输出

Prompt：

- `请用 markdown 给我一份 Vite 和 Next.js 的 5 点对比，带表格。`

预期：

- Desktop 流式显示 Markdown
- 最终消息渲染正常
- 不应只在结束时突然整块出现或文本缺半截

### B-03 final-only text 回归

目标：

- 验证 Desktop 不再把“只有 final 事件中有文本”的回答误判为 `No response`

判定：

- 任意触发工具或复杂推理后，只要 OpenClaw 最终给了文本，Desktop 都应显示文本

### B-04 多 Agent 对齐

步骤：

- 在聊天底部切到一个非 `main` agent
- 发送一个能区分 agent persona 的 prompt

Prompt：

- `你现在是谁？请只回答当前 agent 的名字和职责。`

预期：

- Desktop 真实命中所选 agent
- 行为不能退回 `main`

### B-05 Project Folder -> 默认文件操作目录

目标：

- 验证 Desktop 顶部 `Project Folder` 切换后，聊天里的默认文件操作根目录会落到用户选中的目录
- 验证 agent 自身的 `AGENTS.md` / `SOUL.md` / `USER.md` / `MEMORY.md` 仍然跟随 agent workspace，而不是被 `Project Folder` 覆盖

建议使用临时目录：

- macOS: `/tmp/awarenessclaw-project-folder-proof`

执行步骤：

1. 先清空或新建临时目录
2. 打开 Desktop Chat，点击顶部 `Project Folder`
3. 选择该临时目录
4. 发送 prompt：
  - `请在当前工作区创建一个名为 workspace-proof.txt 的文件，内容只写 WORKSPACE_OK。使用相对路径。`
5. 在本机终端检查：
  - `cat /tmp/awarenessclaw-project-folder-proof/workspace-proof.txt`
6. 再发送 prompt：
  - `列出当前工作区根目录下的文件名。`
7. 再发送 prompt：
  - `请读取 USER.md，并告诉我第一行是什么。`

预期：

- `workspace-proof.txt` 应真实出现在所选目录
- 第二条 prompt 列出的根目录文件应与该临时目录一致
- Settings 中 `AGENTS.md` / `SOUL.md` / `USER.md` 的读写应继续指向 agent workspace，而不是刚才选中的临时目录

失败判定：

- 文件仍写到 `~/.openclaw/workspace` 或其他旧目录
- 模型仍回答“无法访问当前目录”，且终端中该目录没有任何 OpenClaw workspace 痕迹
- `Project Folder` 一切换就把 agent workspace 一并改掉

建议证据：

- Desktop 截图：已选中的 `Project Folder`
- 终端输出：目标目录 `ls -la`
- 如失败，再补 `~/.openclaw/openclaw.json` 中 `agents.defaults.workspace`，确认它没有被 `Project Folder` 意外改写

备注：

- 当前 `openclaw agent` CLI 在不同版本上的参数与会话目标要求较敏感，手工验收优先以 Desktop UI 路径为准，不要只依赖独立 CLI 冒烟

## C. Thinking / Streaming / Tool State

### C-01 live thinking streaming

Prompt：

- `先花一点时间思考，再分步骤回答：如何把一个 Electron 聊天应用接上 Gateway 事件流？`

预期：

- thinking 区域在直播阶段可见
- 文本是 streaming 增长，不是最后一次性出现
- thinking 面板默认展开

### C-02 thinking 自动收起

同一场景继续观察。

预期：

- 当正文开始生成，或工具执行开始可见时，live thinking 面板自动折叠
- 最终 assistant message 中仍保留可折叠的思考内容

### C-03 tool state 生命周期

Prompt：

- `请调用工具完成任务，并在最后总结你做了什么。`

预期：

- 状态流能看到 `thinking -> tool_call / tool_approval / tool_update -> generating -> idle`
- 不能只看到最终一句答案，中间完全黑盒

### C-04 abort 行为

步骤：

- 在长输出或工具执行中点击 Stop

预期：

- 状态结束
- 不会永久卡在 generating
- 下一个请求仍可正常发送

## D. Browser Tool 深测

这组是重点，因为它最容易暴露 Desktop 和 OpenClaw chat 的真实兼容问题。

### D-01 Google 新闻搜索

Prompt：

- `打开 Google，帮我搜索今天的最新新闻，给我 5 条摘要和来源。`

预期：

- 若 Browser tool 正常，应出现浏览器相关 tool 调用或审批
- 最终结果不能退化成 `No response`
- 应能给出新闻摘要和来源，而不是只输出“我需要审批”但后续无路可走

记录：

- 是否出现 `tool_call`
- 是否出现 `tool_approval`
- 最终是否给出来源

### D-02 页面总结

Prompt：

- `打开 Hacker News 首页，告诉我当前前 5 条标题，并总结今天的主题趋势。`

预期：

- 可以导航并读取页面内容
- 最终回答应包含具体标题而不只是泛泛总结

### D-03 多步浏览任务

Prompt：

- `先搜索 OpenClaw gateway websocket chat.send，再打开一个相关结果页面，告诉我关键字段有哪些。`

预期：

- 能完成“搜索 -> 打开结果 -> 读取内容 -> 总结”多跳浏览
- 中间如果需要审批，Desktop 能让用户继续，而不是中断成死路

### D-04 截图型任务

Prompt：

- `打开一个公开网页并截图，然后用一句话描述页面主视觉。`

预期：

- 若底层工具支持截图，应能完成截图相关动作
- 最终回答要与页面实际内容一致

### D-05 表单型任务

步骤：

- 选择一个无副作用测试表单页

Prompt：

- `打开这个测试表单页，尝试填写一组测试数据，但在最终提交前停下来告诉我你填了什么。`

预期：

- 能完成输入与聚焦等浏览器交互
- 不应误触真实提交
- 如果浏览器工具能力不够，应给出明确失败，而不是 silent fail

## E. Tool Approval / Permissions

### E-01 exec 审批

Prompt：

- `请用工具执行 pwd，并只返回当前目录。`

预期：

- 如果当前权限需要审批，应看到 `Approve once`
- 点击审批后，工具继续执行并返回结果

### E-02 Browser 审批

步骤：

- 用一个必然触发浏览器动作的 prompt

预期：

- 若 Browser 工具需要审批，Desktop 必须可见并可继续

### E-03 preset 切换验证

步骤：

- 在 Settings 中切到 `Safe`
- 再跑需要 `exec` 或 Browser 的请求
- 再切回 `Developer`
- 重新跑一次

预期：

- 不同 preset 下行为有明显差异
- `Safe` 不能表现得像全权限开放
- `Developer` 不能仍然像被工具禁用一样

## F. Skill Market + Skill Invocation

### F-01 Skills 页面基础链路

步骤：

- 打开 Skills 页
- 查看 Built-in tab
- 搜索远端 skills
- 打开 skill 详情

预期：

- 已安装 / Explore / Built-in 三块都能工作
- skill 详情可打开

### F-02 安装 / 卸载 skill

步骤：

- 从 Skills 页安装一个非破坏性 skill
- 安装成功后再卸载

预期：

- 安装进度和结果可见
- 卸载后 UI 正确刷新

### F-03 skill 配置编辑

步骤：

- 打开某个已安装 skill 的配置
- 新增一个配置键值
- 保存

预期：

- 配置能持久化到 `openclaw.json`
- 刷新后仍然存在

### F-04 skill 实际调用

步骤：

- 选择一个已安装、可验证输出的 skill

建议优先：

- 搜索类 skill
- GitHub 类 skill
- Obsidian / 知识管理类 skill

Prompt：

- `请使用你已安装的 skill 来完成这个任务，并明确说明你调用了哪个能力。`

预期：

- 能看到 tool 或 skill 相关状态
- 不是只有技能在 UI 列表里，但聊天永远调不起来

## G. Project Folder / Files / Image

### G-01 项目目录注入

步骤：

- 选择一个本地项目目录
- 发送一个要求读文件或改文件的请求

Prompt：

- `请查看当前项目目录里的 package.json，告诉我 scripts 有哪些。`

预期：

- AI 至少知道当前项目目录是什么
- 若路径不存在，Desktop 应给出明确错误

备注：

- 这一项要同时记录“模型口头使用了项目目录”与“真实工具 cwd 是否真的切到该目录”是否一致

### G-02 文本文件附件

步骤：

- 拖入一个文本文件

Prompt：

- `总结这个文件的主要内容。`

预期：

- UI 能显示文件附件
- 模型能利用附件内容回答

### G-03 图片附件理解

步骤：

- 拖入一张图片

Prompt：

- `描述这张图片，并指出其中最显眼的元素。`

预期：

- Desktop 正确识别为 image attachment
- 回答与图片内容匹配

### G-04 混合附件场景

步骤：

- 同时附加文本文件和图片

Prompt：

- `结合这张图和这份说明文档，告诉我两者是否一致。`

预期：

- 不应只识别其中一种附件

## H. Memory 深测

### H-01 自动写入记忆

步骤：

- 完成一轮有明确结论的对话

Prompt：

- `我们决定后续统一用 WebSocket 主路径，不再默认走 CLI fallback。请记住这个决定。`

预期：

- 对话结束后，记忆应被自动记录
- Memory 页面能看到新的事件或卡片

### H-02 新会话 recall

步骤：

- 开新会话

Prompt：

- `我们刚才做了什么决定？`

预期：

- 能召回上一轮关键决定

### H-03 Memory 搜索与摘要

步骤：

- 打开 Memory 页
- 搜索刚才的关键字

预期：

- 搜索结果能命中
- Daily Summary / 时间线不应完全空白

## I. Channels / Unified Inbox

### I-01 加载会话列表

步骤：

- 打开 Channels 页或统一收件箱相关入口

预期：

- 能从 Gateway 读取 channel sessions
- 已有通道会话能展示

### I-02 历史消息加载

步骤：

- 选择一个已有 channel session

预期：

- 能加载历史消息
- 时间顺序和角色正常

### I-03 桌面端回复通道

步骤：

- 在一个 channel session 中发送回复

预期：

- 回复成功进入通道历史
- 失败时有明确反馈

### I-04 实时消息推送

步骤：

- 在外部通道发送一条新消息

预期：

- Desktop 可收到实时推送
- 当前会话若打开，应看到新消息追加

## J. Automation / Cron

### J-01 列表与新增

步骤：

- 打开 Automation 页
- 新增一个无副作用 cron 项

预期：

- 新项可见
- 不会立刻报格式错误或刷新丢失

### J-02 删除

步骤：

- 删除刚才新增的 cron

预期：

- 列表刷新正确

## K. Settings / Config / Doctor

### K-01 Gateway 控制

步骤：

- 在 Settings 中执行 Gateway start / stop / restart

预期：

- 状态变化与实际一致

### K-02 Import / Export

步骤：

- 导出配置
- 再导回一份修改后的配置

预期：

- 不报格式错
- 合并行为符合预期

### K-03 Doctor

步骤：

- 打开 Doctor
- 运行检查

预期：

- 结果可见
- 有 fix 的项可以执行 fix

## L. Failure Recovery / Edge Cases

### L-01 Gateway 未启动

步骤：

- 手动停掉 Gateway
- 再发送聊天请求

预期：

- Desktop 尝试自动拉起 Gateway
- 至少给出清晰状态，而不是无提示卡死

### L-02 WebSocket 失败

步骤：

- 在可控情况下模拟 WS 失败

预期：

- 若设计允许 fallback，应进入 CLI fallback
- 若 fallback 不可用，应给出明确错误

### L-03 权限被拒

步骤：

- 对一个需要审批的工具明确拒绝或不批准

预期：

- Desktop 应停在可理解状态
- 下一个请求不应被连带污染

### L-04 空结果 / only-tool-no-text

目标：

- 验证当 OpenClaw 只有工具活动、没有最终文本时，Desktop 不会把所有情况都模糊压成同一种错误而无法判断

记录：

- 是否看到 tool status
- 是否给了等待审批提示
- 是否出现 `No response`

## M. 建议执行顺序

为了提升效率，建议按下面顺序跑：

1. A 启动基线
2. B chat 基础对齐
3. C thinking / tool 状态流
4. E 权限与审批
5. D browser 深测
6. G 文件 / 图片 / 项目目录
7. F skills
8. H memory
9. I channels
10. J automation
11. K settings / doctor
12. L 异常恢复

## N. 结果记录模板

```md
## Deep Smoke Run YYYY-MM-DD HH:mm

- 环境：macOS / Windows / Linux
- Desktop commit：
- OpenClaw version：
- Gateway：running / restarted / flaky
- Models：
- Skills：
- Memory plugin：enabled / disabled

### 通过项

- A-01 ...
- B-03 ...

### 失败项

- D-01 Google 新闻搜索：fail
  - 输入：...
  - 实际：...
  - 证据：...
  - 初判：Desktop / Gateway / Browser tool / 权限

### flaky 项

- ...

### 关键偏差

- Desktop 独有偏差：...
- OpenClaw 上游偏差：...

### 发布结论

- 是否可发布：yes / no
- 是否允许继续拆分高风险区：yes / no
```

## O. 当前建议重点关注的高风险点

按当前代码状态，最值得优先关注的不是“基础聊天能不能回一句话”，而是下面这些最容易假阳性的点：

1. Browser 请求是否再次退化成 `No response`
2. tool approval 出现后是否真能继续执行，而不是只停在按钮层
3. thinking 是否真的 streaming，且自动折叠行为是否稳定
4. 非 `main` agent 是否真的命中所选 agent
5. Skills 是否只是可安装、不可在 chat 中真实调用
6. 项目目录是否只是 prompt 注入，而不是真正影响工具执行 cwd
7. Memory 是否只是 UI 可见，但实际 recall / auto-capture 不稳定

这 7 项建议每轮深测都至少覆盖一次。