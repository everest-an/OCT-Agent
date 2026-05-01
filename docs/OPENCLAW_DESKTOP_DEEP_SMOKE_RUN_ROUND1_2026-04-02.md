# OCT-Agent Desktop 深度 Smoke Test 第一轮执行单

日期：2026-04-02
用途：第一轮高价值手工深测执行稿
来源：基于 [OPENCLAW_DESKTOP_DEEP_SMOKE_PLAN.md](OPENCLAW_DESKTOP_DEEP_SMOKE_PLAN.md) 抽取的首轮优先场景

## 1. 目标

这一轮不是追求全覆盖，而是优先回答以下问题：

1. Desktop chat 是否还会在复杂场景下退化成 `No response`
2. Browser tool 是否真的能工作，而不只是 UI 宣称支持
3. thinking / tool / approval 状态流是否对用户可见且可继续
4. 多 Agent、skill、memory 这些“看起来有”但最容易假阳性的能力，是否真的贯通
5. 当前最严重的问题更像是 Desktop 封装问题、OpenClaw 上游问题，还是权限 / 配置问题

## 2. 执行前准备

开始前先记下：

- OS：
- Desktop commit：
- OpenClaw version：
- 模型：
- Gateway 状态：
- 当前权限 preset：
- `exec` 是否已允许：
- 已安装 skills：
- Memory plugin：enabled / disabled

建议同时打开：

- Desktop 应用
- Desktop DevTools console
- OpenClaw Dashboard 或可观察 Gateway 状态的窗口

## 3. 第一轮 10 个优先场景

## R1-01 Browser 新闻搜索回归

目的：直接打最容易复发的 `No response` 场景。

Prompt：

`打开 Google，帮我搜索今天的最新新闻，给我 5 条摘要和来源。`

重点观察：

- 是否出现 Browser 相关 `tool_call`
- 是否出现审批
- 是否再次出现 `No response`
- 最终是否给出真实来源

记录：

- 结果：pass / fail / flaky
- 实际：
- 偏差归因：Desktop / Gateway / 权限 / Browser tool

## R1-02 多步浏览任务

目的：验证不是只有单步页面读取，浏览器多跳链路也能走通。

Prompt：

`先搜索 OpenClaw gateway websocket chat.send，再打开一个相关结果页面，告诉我关键字段有哪些。`

重点观察：

- 搜索、打开结果、读取内容三步是否完整
- 中途若需要审批，Desktop 是否可继续
- 最终答案是否具体，而不是泛泛而谈

记录：

- 结果：
- 实际：
- 是否出现中途断流：yes / no

## R1-03 exec 审批与继续执行

目的：验证 approval flow 不是只显示按钮，而是真的能继续跑完。

Prompt：

`请用工具执行 pwd，并只返回当前目录。`

重点观察：

- 是否出现 `Approve once`
- 点击后是否真的继续执行
- 是否得到 `tool_result` 或等价完成状态

记录：

- 结果：
- 审批前状态：
- 审批后状态：
- 最终输出：

## R1-04 thinking streaming + 自动收起

目的：验证你最关心的 reasoning 体验。

Prompt：

`先花一点时间思考，再分步骤回答：如何把一个 Electron 聊天应用接上 Gateway 事件流？`

重点观察：

- thinking 是否 streaming
- live thinking 面板是否默认展开
- 正文开始生成或工具开始执行后是否自动折叠
- 最终消息里是否保留可折叠 thinking

记录：

- 结果：
- live thinking 表现：
- auto-collapse 表现：
- 最终 thinking 保留：yes / no

## R1-05 多 Agent 对齐

目的：验证 Desktop WS 主路径与 OpenClaw agent 选择是否一致。

步骤：

- 切换到一个非 `main` agent

Prompt：

`你现在是谁？请只回答当前 agent 的名字和职责。`

重点观察：

- 是否真的命中选中的 agent
- 是否退回默认 main

记录：

- 结果：
- 所选 agent：
- 实际回答：

## R1-06 skill 真实调用

目的：验证 skill 不是只存在于 Skills 页面，而是真的能在 chat 中触发。

前提：

- 选择一个已安装且有明确输出的 skill

建议优先：

- 搜索类 skill
- GitHub 类 skill

Prompt：

`请使用你已安装的 skill 来完成这个任务，并明确说明你调用了哪个能力。`

重点观察：

- skill 是否真实参与执行
- 是否能看到相关 tool / status
- 结果是否与 skill 能力匹配

记录：

- skill 名称：
- 结果：
- 实际：

## R1-07 Memory auto-capture + recall

目的：验证 Desktop chat 的记忆闭环。

第一步 Prompt：

`我们决定后续统一用 WebSocket 主路径，不再默认走 CLI fallback。请记住这个决定。`

第二步：

- 开一个新会话

第二步 Prompt：

`我们刚才做了什么决定？`

重点观察：

- 第一轮是否被写入记忆
- 第二轮是否能召回

记录：

- 结果：
- auto-capture：pass / fail
- recall：pass / fail

## R1-08 项目目录真实有效性

目的：验证“项目目录”到底只是 prompt 注入，还是确实能影响任务执行。

步骤：

- 选择一个本地项目目录

Prompt：

`请查看当前项目目录里的 package.json，告诉我 scripts 有哪些。`

重点观察：

- 模型是否能正确引用项目目录
- 输出是否符合该目录下真实文件内容
- 若失败，是路径问题、cwd 问题还是权限问题

记录：

- 结果：
- 目录：
- 输出：
- 是否怀疑 cwd 未真正切换：yes / no

## R1-09 图片附件理解

目的：验证附件链路和模型输入组装没有坏。

步骤：

- 拖入一张图片

Prompt：

`描述这张图片，并指出最显眼的元素。`

重点观察：

- UI 是否把附件识别成图片
- 模型回答是否与图片内容匹配

记录：

- 结果：
- 图片名称：
- 实际回答：

## R1-10 Gateway 恢复能力

目的：验证 Desktop 在最常见运行时异常下不会直接死。

步骤：

- 手动停掉 Gateway
- 再发送一条简单请求

Prompt：

`你好，告诉我你是否已经恢复连接。`

重点观察：

- Desktop 是否尝试自动拉起 Gateway
- 是否给出明确状态反馈
- 是否能恢复到可继续聊天状态

记录：

- 结果：
- 自动恢复：pass / fail
- 用户可见文案：

## 4. 推荐执行顺序

按这个顺序跑最省时间：

1. R1-10 Gateway 恢复能力
2. R1-01 Browser 新闻搜索回归
3. R1-03 exec 审批与继续执行
4. R1-04 thinking streaming + 自动收起
5. R1-02 多步浏览任务
6. R1-05 多 Agent 对齐
7. R1-06 skill 真实调用
8. R1-08 项目目录真实有效性
9. R1-09 图片附件理解
10. R1-07 Memory auto-capture + recall

理由：

- 先排掉 runtime / gateway 级 blocker
- 再验证最容易假阳性的 Browser / approval / thinking
- 再看 multi-agent / skills / memory 等更高层能力

## 5. 第一轮结论模板

```md
## Round 1 Smoke Run YYYY-MM-DD HH:mm

- OS：
- Desktop commit：
- OpenClaw version：
- Model：
- Gateway：
- Permissions preset：

### 通过项

- R1-03 exec 审批与继续执行
- R1-09 图片附件理解

### 失败项

- R1-01 Browser 新闻搜索回归
  - 实际：
  - 偏差归因：

### flaky 项

- R1-06 skill 真实调用
  - 第一次：
  - 第二次：

### 本轮最严重问题

- 

### 下一轮建议

- 
```

## 6. 当前判定门槛

如果第一轮里出现以下任一情况，应直接视为高优先级问题：

1. Browser 请求再次出现 `No response`
2. thinking 不能 streaming 或不能自动折叠
3. approval 按钮可见但无法继续执行
4. 非 `main` agent 实际不生效
5. skill 可安装但 chat 完全调不起来
6. Memory 无法完成“写入 + 新会话召回”闭环

只要命中其中任何一项，就不建议把 Desktop chat 与 OpenClaw chat 视为“已经充分对齐”。