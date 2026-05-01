# OCT-Agent Desktop 未闭环问题修复方案

最后更新：2026-04-02

## 1. 目标

这份文档只回答一个问题：

> 当前还没闭环的能力，要怎么修，才能最终把 OCT-Agent Desktop 推到“接近 OpenClaw chat 全功能对齐”的状态。

这里不再重复“哪些没闭环”，只给对应的解决路径、优先级、修复方式和验收标准。

## 2. 总体优先级

建议按下面顺序处理，不要再全量散测：

1. `workspace cwd`
2. `approval / tool continue`
3. `memory write -> recall`
4. `browser / web search`

原因：

- `workspace cwd` 和 `approval` 更像 Desktop 接入层问题，修复收益最高
- `memory recall` 需要 Desktop 和 Awareness memory 协议一起看
- `browser` 当前主要卡在环境前置条件，优先级应低于真正的桌面接入缺口

## 3. 各问题怎么解决

## A. Workspace / Project Folder 没闭环

### 当前现象

Desktop 只是把项目路径作为提示词注入，而不是真正把 OpenClaw 的工作目录切过去。

相关代码：

- [Dashboard.tsx](/Users/edwinhao/Awareness/OCT-Agent/packages/desktop/src/pages/Dashboard.tsx#L762)
- [register-chat-handlers.ts](/Users/edwinhao/Awareness/OCT-Agent/packages/desktop/electron/ipc/register-chat-handlers.ts#L103)

现在的实现只是：

- 前端传 `workspacePath`
- 主进程把它拼成 `[Current project directory: ...]` 注入到 prompt

这不是真正的 cwd 语义，所以模型会继续按默认目录理解环境。

### 根因判断

这是 Desktop 接 OpenClaw 时的“弱接入”问题，不是模型问题。

### 最小修复方案

应改成“显式会话级 workspace 绑定”，不要继续只靠 prompt：

1. 先确认 OpenClaw/Gateway 当前是否支持 chat.send 的 workspace/session 级字段或 config patch。
2. 如果支持：Desktop 在发消息前，把 `workspacePath` 真正下发给 OpenClaw，而不是只拼 prompt。
3. 如果当前 Gateway 不支持：Desktop 侧至少引入“agent/workspace profile”，让所选 project folder 被写入 OpenClaw agent/workspace 配置，然后再发消息。
4. 在 UI 上把“当前项目目录已作为真实工作目录生效”与“当前只是提示词模式”明确区分，避免假闭环。

### 不建议的做法

- 不要继续增强 prompt 文案试图“诱导模型记住 cwd”
- 不要把更多文件列表硬塞进 prompt 伪装成 workspace 支持

### 验收标准

以下 prompt 必须稳定通过：

- `Inspect package.json in the current project directory and list the scripts.`
- `Run pwd and tell me the current project root.`
- `Open ./src and summarize the first three files.`

要求：

- 不再出现“当前目录没有 package.json”这类假阴性
- 相对路径行为与选中的 project folder 一致

## B. Approval / Tool Continue 没闭环

### 当前现象

UI 已经能显示 approval，但真实链路没有稳定闭成：

`approval.requested -> /approve -> tool_result -> final text`

相关代码：

- [register-chat-handlers.ts](/Users/edwinhao/Awareness/OCT-Agent/packages/desktop/electron/ipc/register-chat-handlers.ts#L137)
- [register-chat-handlers.ts](/Users/edwinhao/Awareness/OCT-Agent/packages/desktop/electron/ipc/register-chat-handlers.ts#L352)
- [Dashboard.tsx](/Users/edwinhao/Awareness/OCT-Agent/packages/desktop/src/pages/Dashboard.tsx#L809)

现在的实现本质上是：

- 捕获 `*.approval.requested`
- 拼一个 `/approve <id> allow-once`
- 前端再发起第二次 `chatSend`

这意味着审批不是“继续当前执行”，而是“发一条新消息去批准”。

### 根因判断

当前问题至少有两层：

1. Desktop 侧把批准动作实现成“重新发 chat message”，语义偏弱。
2. 宿主审批策略和模型分支不稳定，导致有时根本没进入 approval，而是直接失败或直接拒答。

### 最小修复方案

建议拆成两步修：

#### 第一步：Desktop 先改成真正 approval RPC

目前已经有：

- [register-chat-handlers.ts](/Users/edwinhao/Awareness/OCT-Agent/packages/desktop/electron/ipc/register-chat-handlers.ts#L61)
- [preload.ts](/Users/edwinhao/Awareness/OCT-Agent/packages/desktop/electron/preload.ts#L33)

说明 Desktop 已经准备了 `chat:approve` 接口，但前端没有主用它，而是继续走 `/approve ...` 文本消息。

应改成：

1. 前端点击 `Approve once` 时优先走 `chatApprove(sessionId, approvalRequestId)`。
2. 主进程通过 Gateway/宿主原生 approval 通道继续执行原会话。
3. 只有在宿主没有 approval RPC 时，才退回 `/approve ...` 文本命令。

#### 第二步：补一条“approval 会话继续”状态机

当前 UI 里 approval 更像一次独立消息交互。应改成：

1. 审批前保留当前 toolCall 状态为 `awaiting_approval`
2. 审批成功后把同一 toolCall 切到 `approved`
3. 继续等待同一会话里的 `tool_result / final`
4. 不新建一条伪 assistant 结论，避免割裂感

### 验收标准

下面链路必须稳定通过至少 5 次：

1. 模型触发 `exec`
2. Desktop 展示 approval 卡片
3. 点击 `Approve once`
4. 工具继续执行
5. 最终 assistant 给出执行结果

且不能退化成：

- `No response`
- 只显示批准消息，不显示工具结果
- 批准后新开一轮会话语义

## C. Memory Write -> Recall 没闭环

### 当前现象

写入看起来成功，但新会话 recall 没稳定命中刚写入内容。

相关代码接触面：

- [register-memory-handlers.ts](/Users/edwinhao/Awareness/OCT-Agent/packages/desktop/electron/ipc/register-memory-handlers.ts#L121)
- [register-memory-handlers.ts](/Users/edwinhao/Awareness/OCT-Agent/packages/desktop/electron/ipc/register-memory-handlers.ts#L133)

Desktop 当前：

- 搜索走 `awareness_recall`
- 初始化上下文走 `awareness_init`

但这两条调用现在都没有把 Desktop chat session 的上下文强绑定进去。

### 根因判断

大概率不是“写失败”，而是下面几种之一：

1. 写入后索引延迟，马上 recall 命不中
2. recall 查询词太弱，没召回新内容
3. `session_id` 或 source 没被正确带入，导致“刚刚这轮对话”的上下文没有优先检索
4. awareness_init / awareness_recall 当前更偏总结性召回，不适合验证“刚刚写入的精确事实”

### 最小修复方案

这里不要先改搜索算法，先把 Desktop 接入做实：

1. Desktop chat 会话必须生成稳定的 `session_id`，并在 memory record / recall / init 上统一传递。
2. `awareness_record` 的写入来源需要带上更明确的 `source=desktop-chat` 和 session 元数据。
3. `awareness_recall` 增加“优先当前 session / 最近写入”的参数路径，如果协议不支持，就先在 Desktop 侧分两段查：
   - 先查当前 session 最近事件
   - 再查全局 recall
4. Desktop UI 里把“刚写入成功”和“可被召回验证成功”分开，不要把模型口头说成功当作事实成功。

### 验收标准

以下链路要通过：

1. 会话 A 写入一条明确事实
2. 新开会话 B，问刚才那条事实
3. recall 能命中对应内容
4. Desktop Memory 页也能搜索到同一条内容

如果只能写入成功、不能召回，就不能算闭环。

## D. Browser / Web Search 没闭环

### 当前现象

当前 Browser 更多是“环境没配好”，不是纯 Desktop 回归。

### 根因判断

Browser 这块当前是两层问题：

1. 环境前置条件不满足，比如缺 API key
2. 用户不知道自己当前用的是哪种 provider，也不知道缺什么

第二点这轮已经部分修了：Desktop Settings 已经支持 schema 驱动的 Web 配置和 provider 提示。

相关代码：

- [Settings.tsx](/Users/edwinhao/Awareness/OCT-Agent/packages/desktop/src/pages/Settings.tsx#L678)

### 最小修复方案

1. 用 Desktop Settings 把当前 provider 和 API key 填完整。
2. 给 Browser / Web Search 单独补一个 Health Check：
   - provider 是谁
   - key 是否存在
   - OpenClaw 当前是否认为 `tools.web.search.enabled=true`
3. 在 Skills 或 Settings 页显示“当前 Browser 依赖的是 web search 还是 browser-backed 模式”，避免用户误会是 Chrome 自动化。

### 验收标准

以下 prompt 至少要通过其中一个稳定 provider：

- `Open Google and search for today's latest news, then give me 5 summaries with sources.`

要求：

- 不再报缺 API key
- 返回真实来源
- Desktop 可见中间状态而非静默失败

## 4. 最关键的一条原则

不要再试图用“加 prompt”“加提示词”“加 fallback 文案”来宣布闭环。

真正的闭环标准只有一个：

> 同一条高阶能力链路，必须能在 Desktop 上真实、稳定、可重复地走完整个执行过程，并拿到最终结果。

也就是：

- 不是“看起来像支持”
- 不是“代码里已经有分支”
- 不是“模型说它做了”

而是：

- 真触发
- 真执行
- 真返回
- 真可复测

## 5. 最小落地建议

如果现在只选一个最值得立刻开工的点，我建议先做：

1. `approval` 改原生 RPC 继续执行
2. `workspace` 改真 cwd / 真 workspace 绑定

这两个一旦修住，Desktop 和 OpenClaw chat 的“像不像同一套能力”会直接上一个台阶。