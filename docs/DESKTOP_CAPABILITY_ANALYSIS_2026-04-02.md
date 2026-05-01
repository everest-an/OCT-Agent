# OCT-Agent Desktop 能力分析

日期：2026-04-02

范围：基于当前仓库代码与文档，对 OCT-Agent 桌面版是否具备 `computer use` / `browser use` 能力进行代码级分析，并区分“已经可用的 OpenClaw 工具能力”与“尚不能严谨宣称的标准化能力”。

## 结论

当前的 OCT-Agent 桌面版，已经能够通过 OpenClaw 底层使用以下能力：

- 浏览器自动化能力
- Shell / Code 执行能力
- 文件系统读写能力
- 图片分析能力
- Chat 中的工具调用状态展示与审批流

但如果 `computer use` 指的是标准化的桌面 GUI 代理能力，例如鼠标键盘驱动、窗口级操作、整机桌面截图闭环、类似 OpenAI / Anthropic 语境中的 desktop computer use，那么当前仓库中没有足够证据表明已经接入该能力。

因此，当前最准确的产品表述应为：

> OCT-Agent Desktop 已通过 OpenClaw 暴露浏览器、Shell、文件系统、图片分析等内置工具能力，并可在 chat 流程中实际调用与审批；但暂不应对外宣称已经具备标准化的 desktop computer use 能力。

## 术语区分

为了避免后续沟通混淆，需要先区分两类能力：

### 1. 广义 browser use

指浏览网页、点击页面、截图、填表单、提交页面动作等浏览器自动化能力。

这一类能力，当前仓库有明确证据支持。

### 2. 标准化 computer use

指桌面 GUI 级别代理能力，例如：

- 鼠标移动、点击、拖拽
- 键盘输入
- 面向整个系统桌面的截图与坐标操作
- 非浏览器窗口交互

这一类能力，当前仓库没有明确实现证据。

## 关键证据

## 1. 桌面版会主动打开 OpenClaw 的工具能力

`packages/desktop/electron/desktop-openclaw-config.ts` 会给 OpenClaw 配置默认写入 `tools.profile = "coding"`：

- [desktop-openclaw-config.ts](../packages/desktop/electron/desktop-openclaw-config.ts#L22)
- [desktop-openclaw-config.ts](../packages/desktop/electron/desktop-openclaw-config.ts#L24)

对应代码逻辑：

```ts
config.tools = {
  ...(config.tools || {}),
  profile: config.tools?.profile || 'coding',
};
```

这说明桌面版不是单纯展示某个能力，而是在配置层主动把 OpenClaw 放到了一个允许更多内置工具的档位。

同一文件还会默认加入以下 Awareness 相关工具白名单：

- `exec`
- `awareness_init`
- `awareness_recall`
- `awareness_lookup`
- `awareness_record`
- `awareness_get_agent_prompt`

这进一步说明桌面版的默认能力模型是“带工具、可执行、可记忆”的代理模式，而不是纯文本聊天模式。

## 2. 前端明确把 Browser / Shell / File / Image 定义为内置能力

`packages/desktop/src/pages/Skills.tsx` 中的 `BUILTIN_CAPABILITIES` 明确列出了 OpenClaw 内置能力：

- [Skills.tsx](../packages/desktop/src/pages/Skills.tsx#L31)
- [Skills.tsx](../packages/desktop/src/pages/Skills.tsx#L32)
- [Skills.tsx](../packages/desktop/src/pages/Skills.tsx#L33)
- [Skills.tsx](../packages/desktop/src/pages/Skills.tsx#L34)

关键定义包括：

```ts
{ icon: Globe, nameKey: 'Browser', descKey: 'Navigate, click, screenshot, fill forms — full browser control', ... }
{ icon: Terminal, nameKey: 'Shell / Code', descKey: 'Execute commands, run scripts, manage processes', ... }
{ icon: FolderOpen, nameKey: 'File System', descKey: 'Read, write, edit files in your project', ... }
{ icon: Eye, nameKey: 'Image Analysis', descKey: 'Understand and describe images', ... }
```

这里至少可以确认两件事：

- 团队对外定义中，浏览器自动化能力是 OpenClaw 内置能力的一部分。
- 当前桌面产品文案已经把这套能力解释为“开箱即用”，不是未来规划。

## 3. Chat 链路会把 OpenClaw 的工具调用真正暴露到 UI

`packages/desktop/electron/ipc/register-chat-handlers.ts` 不是简单转发文本，而是在消费 Gateway 的事件流。

相关关键位置：

- [register-chat-handlers.ts](../packages/desktop/electron/ipc/register-chat-handlers.ts#L52)
- [register-chat-handlers.ts](../packages/desktop/electron/ipc/register-chat-handlers.ts#L61)
- [register-chat-handlers.ts](../packages/desktop/electron/ipc/register-chat-handlers.ts#L141)
- [register-chat-handlers.ts](../packages/desktop/electron/ipc/register-chat-handlers.ts#L153)
- [register-chat-handlers.ts](../packages/desktop/electron/ipc/register-chat-handlers.ts#L193)
- [register-chat-handlers.ts](../packages/desktop/electron/ipc/register-chat-handlers.ts#L198)
- [register-chat-handlers.ts](../packages/desktop/electron/ipc/register-chat-handlers.ts#L200)
- [register-chat-handlers.ts](../packages/desktop/electron/ipc/register-chat-handlers.ts#L240)

可以确认的行为：

1. `chat:send` 会先确保 Gateway 已运行，再通过 `ws.chatSend(...)` 把请求发给 OpenClaw。
2. 如果 Gateway 返回 `*.approval.requested` 事件，桌面端会把它映射成 `tool_approval` 状态并送往前端。
3. 如果消息块中出现 `tool_use`，桌面端会把它映射成 `tool_call` 运行态。
4. 如果出现 `tool_result`，桌面端会把该工具调用标记为完成。

这意味着当前聊天能力已经不是“只会看到最终文本答复”，而是能够感知到底层工具执行生命周期。

## 4. 前端 Dashboard 确实展示并处理工具审批

`packages/desktop/src/pages/Dashboard.tsx` 会消费主进程发来的 `tool_call` / `tool_approval` / `tool_update`：

- [Dashboard.tsx](../packages/desktop/src/pages/Dashboard.tsx#L448)
- [Dashboard.tsx](../packages/desktop/src/pages/Dashboard.tsx#L455)
- [Dashboard.tsx](../packages/desktop/src/pages/Dashboard.tsx#L470)

同时，Dashboard 已经有实际的审批动作：

- [Dashboard.tsx](../packages/desktop/src/pages/Dashboard.tsx#L759)
- [Dashboard.tsx](../packages/desktop/src/pages/Dashboard.tsx#L760)

当前实现方式是：用户点击“Approve once”后，前端把 `/approve ... allow-once` 当作一条 chat 请求重新发给 Gateway，而不是完全独立的审批通道。

这说明：

- 工具审批不只是主进程内部状态
- 用户在聊天界面里可以看到并批准工具继续执行
- 这套能力已经形成了可交互的产品闭环

## 5. OpenClaw 集成本身以“可见工具”为前提

根仓库文档 `docs/OPENCLAW_INTEGRATION.md` 明确写到：

- [OPENCLAW_INTEGRATION.md](../../docs/OPENCLAW_INTEGRATION.md#L39)

文档原文：

> Restart OpenClaw and type `/tools` to see the available tools.

这条证据虽然是针对记忆插件集成，但它表明 OpenClaw 本身就是基于“已加载工具列表”运作的，桌面版的 Browser / Shell / File 等能力也应理解为 OpenClaw 工具体系的一部分，而不是桌面应用自己造的一层假 UI。

## 6. 当前仓库没有 `computer_use` / `browser_use` 的显式实现名

在排除 `node_modules`、`.pnpm-store`、`.venv`、`dist` 等依赖与构建产物后，当前项目业务代码与文档中没有检索到以下术语：

- `computer_use`
- `computer use`
- `browser_use`
- `browser use`

这意味着：

- 当前仓库没有把这套能力公开实现为某个标准化 `computer_use` / `browser_use` 协议
- 现阶段更准确的说法应是“OpenClaw Browser / Shell / File / Image 等内置能力”
- 不应把“有浏览器自动化工具”直接等同于“已接入标准 computer use”

## 当前可严谨宣称的能力矩阵

| 能力类别 | 当前状态 | 证据强度 | 说明 |
|---|---|---:|---|
| 浏览器自动化 | 有 | 高 | Skills 页明确写有 Browser，文案包括 click / screenshot / fill forms，且默认 `tools.profile = coding` |
| Shell / Code 执行 | 有 | 高 | Skills 页明确列出，桌面默认允许 `exec` |
| 文件系统读写 | 有 | 高 | Skills 页明确列出 File System |
| 图片分析 | 有 | 高 | Skills 页明确列出 Image Analysis；chat 附件逻辑也支持图片输入 |
| Chat 中工具状态展示 | 有 | 高 | `tool_use` / `tool_result` / `approval.requested` 已接入 UI |
| Chat 中工具审批 | 有 | 高 | Dashboard 有审批按钮并会发送 `/approve ... allow-once` |
| 标准化 browser_use 协议 | 不明确 | 低 | 没有显式术语或协议实现名 |
| 标准化 desktop computer use | 无明确证据 | 低 | 未见桌面坐标、鼠标键盘、窗口级 GUI 控制实现 |

## 当前最准确的对外说法

如果需要对外描述当前产品能力，建议使用如下说法：

> OCT-Agent Desktop 通过 OpenClaw 底层提供浏览器、Shell、文件系统、图片分析等内置工具能力，并已在聊天界面中支持工具调用展示与审批。

不建议直接使用如下说法：

- “已经支持标准 computer use”
- “已经接入 browser_use 协议”
- “已经具备完整桌面 GUI 代理能力”

因为这些说法在当前仓库中没有足够代码证据支撑。

## 风险与边界

### 1. 产品文案和底层真实工具名可能并不完全一一对应

前端使用的是“Browser / Shell / Code / File System / Image Analysis”这种产品化命名，但当前仓库并没有直接展示 OpenClaw 在 `tools.profile = coding` 下展开出的完整工具列表。

因此，当前能够确认的是“产品和接线层面支持这些能力”，但不能仅凭仓库静态代码精确列出每一个底层工具 ID。

### 2. 工具审批采用聊天命令式路径

虽然主进程已经提供 `chat:approve` IPC，但当前前端实际审批路径是把 `/approve ... allow-once` 作为聊天消息再次发送。

这不是错误，但意味着审批链路仍然依赖 chat command 语义，而非完全独立的审批 API 流程。

### 3. 没有证据显示非浏览器桌面窗口自动化

当前证据都集中在：

- Browser
- Shell / Code
- File System
- Image Analysis

并没有看到例如桌面截图坐标点击、系统窗口枚举、鼠标移动、按键模拟等实现，因此不能扩展解释成“整机 computer use”。

## 如果要把结论再做实，需要补什么

若后续想把这件事从“代码静态判断”提升到“可演示结论”，建议再做两类验证。

### 1. 反查本机 OpenClaw 安装产物

目标：确认 `tools.profile = coding` 在本机 OpenClaw 版本中到底展开成哪些真实工具名。

建议做法：

- 检查 OpenClaw 安装目录下的 tool registry / dist metadata
- 运行 `/tools` 并记录工具列表
- 验证 Browser 对应的底层工具名与权限模型

### 2. 做真实聊天 smoke test

目标：验证 Browser 工具是否真的会在聊天里触发。

建议 prompt：

- “打开某个网页并总结页面内容”
- “搜索一个结果并截图”
- “进入一个表单页并尝试填写”

观察点：

- 是否出现 `tool_call`
- 是否出现 `tool_approval`
- 工具名称是什么
- 结果是否反映浏览器真实动作

## 最终判断

基于当前仓库代码，可以明确确认：

1. OCT-Agent Desktop 已接入 OpenClaw 的浏览器、Shell、文件系统、图片分析等工具能力。
2. 这些能力已经接进聊天链路，而不是仅存在于配置或文案层。
3. 用户已经可以在聊天 UI 中看到工具调用与审批状态。

但基于当前仓库代码，不能严谨确认：

1. 已接入标准化 `browser_use` 协议。
2. 已具备标准化桌面 GUI 级 `computer use` 能力。

因此，现阶段最准确的内部结论是：

> OCT-Agent Desktop 已具备基于 OpenClaw 的 browser automation 与通用工具调用能力，但尚不能仅凭仓库代码宣称已具备标准化 desktop computer use。