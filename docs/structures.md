# AwarenessClaw Desktop Main Process Structures

最后更新：2026-04-01
适用范围：`packages/desktop/electron/main.ts` 以及后续所有 Electron 主进程拆分工作

## 1. 目的

这份文档不是“理想架构图”，而是 `main.ts` 的低风险重构施工手册。

当前事实：

- `packages/desktop/electron/main.ts` 约 4015 行
- 包含约 60+ 个 `ipcMain.handle(...)`
- 同时承担窗口生命周期、托盘、OpenClaw 配置写入、Gateway 启停、聊天流式转发、Channel 登录、Daemon 健康检查、Memory API、Doctor、配置导入导出等职责

这个文件已经是典型 God File，但它也是一个已经被反复验证过的稳定入口。因此，重构目标不是“重写得更优雅”，而是：

1. 保持行为完全不变
2. 尽量只做 copy/paste 级别提取
3. 每一步都可以单独回滚
4. 先缩小文件，再考虑抽象

## 2. 不可违反的重构红线

任何人修改 `packages/desktop/electron/main.ts` 或拆分其逻辑时，必须遵守以下规则：

1. 先提取，再整理。第一阶段只允许“搬代码”，不允许顺手改逻辑。
2. 先复制原函数到新文件，再让 `main.ts` 调用新函数。不要一边搬一边改实现。
3. 不改 IPC channel 名称。比如 `chat:send`、`channel:setup`、`gateway:start` 必须原样保留。
4. 不改返回结构。前端已经依赖这些 shape，哪怕字段命名不理想也不能在重构时顺手改。
5. 不改命令字符串。`openclaw ...`、`npx ...`、shell 参数、timeout、平台分支都视为行为，不是样式。
6. 不改全局状态语义。`mainWindow`、`gatewayWsClient`、`daemonStartupPromise`、`isQuitting`、`watchdogInterval` 等必须保持原有生命周期。
7. 不提前合并相似函数。哪怕看起来重复，也优先保留重复，等拆完再决定是否去重。
8. 不把 Electron 生命周期钩子拆得过碎。`app.whenReady()`、`app.on('second-instance')`、`app.on('before-quit')` 仍应保留在主入口附近。
9. 不把跨模块共享状态偷偷改成 class。主进程现在是“模块级单例 + 闭包依赖”模型，重构第一阶段不要引入新状态机。
10. 每次只拆一个责任块。一次 PR 最多动一个功能域，否则无法定位回归。

一句话原则：第一阶段允许移动代码，不允许发明新设计。

### 当前执行边界（2026-04-01）

到当前版本为止，以下边界已经确认：

- 低风险和中低风险的 `channel` 注册器拆分已经做到合理上限
- `channel:setup` 已经拆到“编排”和“QR/login 流”两个模块，先停在这里，不再继续往更细粒度拆
- `chat:*` 与 app lifecycle 默认暂停继续拆分，除非先补真实链路验证

这不是“永远不拆”，而是当前验证能力下的停止线。后续如需继续，先补验证，再继续搬代码。

## 3. 当前结构地图

以下按 `main.ts` 的真实职责分区整理，行号以 2026-04-01 的版本为基准。

### 3.1 启动级全局状态

主要单例和共享状态：

- `mainWindow`
- `tray`
- `isQuitting`
- `daemonStartupPromise`
- `daemonStartupLastKickoff`
- `gatewayWsClient`
- `activeChatChild`
- `_discoveryDone`
- `_channelStatusCache`
- `watchdogInterval`
- `daemonEverConnected`

这些状态目前跨多个 IPC handler 和生命周期钩子共享，第一阶段不要试图“面向对象化”。

### 3.2 适合优先提取的低风险区域

这些区域具备“输入输出比较明确、依赖较少、copy/paste 后易验证”的特征。

#### A. Runtime Preferences

大致范围：文件开头到 `readRuntimePreferences` / `writeRuntimePreferences`

职责：

- `~/.awareness-claw/runtime-preferences.json` 路径
- 运行时偏好读写

建议目标文件：

- `packages/desktop/electron/runtime-preferences.ts`

原因：

- 纯文件读写
- 无 Electron 生命周期依赖
- 几乎没有 UI 事件耦合

#### B. Shell / PATH Utilities

大致范围：`findNodeExecutable` 到 `runAsync` 一段

职责：

- `getEnhancedPath`
- `safeShellExec`
- `safeShellExecAsync`
- `readShellOutputAsync`
- `runAsync`
- Windows command 包装
- managed runtime command 改写

建议目标文件：

- `packages/desktop/electron/shell-utils.ts`

注意：

- 不要修改任何 shell 行为
- `--norc --noprofile` 必须原样保留
- 所有 timeout、env 注入顺序、PATH 拼接顺序都必须原样复制

#### C. Local Daemon Client

大致范围：本地 daemon 启动、healthz、HTTP 请求相关函数

职责：

- `startLocalDaemonDetached`
- `waitForLocalDaemonReady`
- `getLocalDaemonHealth`
- `shutdownLocalDaemon`
- `requestLocalDaemon`

建议目标文件：

- `packages/desktop/electron/local-daemon.ts`

原因：

- 主要是 HTTP + spawn
- 边界清晰
- 与 renderer 的耦合较弱

#### D. Memory Client

大致范围：`callMcp` / `callMcpStrict` + `memory:*` IPC handler 依赖的 HTTP 封装

建议目标文件：

- `packages/desktop/electron/memory-client.ts`

注意：

- 第一阶段只提取 HTTP client 函数，不要同时提取 IPC 注册

#### E. File Dialogs / File Preview

大致范围：

- `file:preview`
- `file:select`
- `directory:select`

建议目标文件：

- `packages/desktop/electron/file-dialogs.ts`

原因：

- 职责独立
- 容易肉眼验证
- 对主流程影响小

#### F. Internal Hook Deployment

大致范围：`ensureInternalHook`

建议目标文件：

- `packages/desktop/electron/internal-hook.ts`

原因：

- 幂等、独立
- 与大部分 IPC 无耦合

#### G. Daemon Watchdog

大致范围：

- `startDaemonWatchdog`
- `stopDaemonWatchdog`
- `daemon:mark-connected`

建议目标文件：

- `packages/desktop/electron/daemon-watchdog.ts`

注意：

- 需要通过参数注入 `mainWindow` 或发送函数，不要在新文件里隐式引用不存在的全局变量

### 3.3 中风险区域

这些区域可以拆，但必须放在低风险区之后。

#### H. OpenClaw Config Merge / Sanitization

大致范围：

- `applyAwarenessPluginConfig`
- `sanitizeAwarenessPluginConfig`
- `persistAwarenessPluginConfig`
- `mergeOpenClawConfig`
- `redactSensitiveValues`
- `stripRedactedValues`

建议目标文件：

- `packages/desktop/electron/openclaw-config-io.ts`

风险来源：

- 配置合并是脆弱逻辑
- 插件 slots、allow-list、entries 都有历史兼容问题
- 很容易在“顺手整理”时引入配置漂移

规则：

- 提取时必须逐行复制
- 不能把 merge 逻辑“简化”成通用 deep merge

#### I. Setup IPC Group

涉及：

- `setup:detect-environment`
- `setup:install-nodejs`
- `setup:install-openclaw`
- `setup:install-plugin`
- `setup:start-daemon`
- `setup:save-config`
- `setup:bootstrap`
- `setup:read-existing-config`

建议目标形态：

- `packages/desktop/electron/ipc/register-setup-handlers.ts`

注意：

- 这里不是把逻辑重写成 service，而是把整组 handler 注册封装成一个 `registerSetupHandlers(deps)`
- handler 内部逻辑允许先完全复制

#### J. Gateway Lifecycle

涉及：

- `startGatewayInUserSession`
- `startGatewayWithRepair`
- `ensureGatewayRunning`
- `gateway:*` IPC

建议目标形态：

- `packages/desktop/electron/gateway-runtime.ts`
- 或 `packages/desktop/electron/ipc/register-gateway-handlers.ts`

风险来源：

- Windows service repair
- 权限失败 fallback
- 运行时提示通过 `mainWindow.webContents.send(...)` 回推到前端

这个区域可以拆，但必须在 shell utils 和 runtime preferences 稳定之后再动。

### 3.4 高风险区域，暂时不要先动

这些区域最容易因为重构而破坏行为。

#### K. chat:send / chat:abort

风险来源：

- Gateway auto-start 前置依赖
- WebSocket 流式事件转发
- CLI fallback
- sessionId / workspacePath / files / agentId 组合逻辑
- active child process 中止语义

结论：

- 在没有补充集成测试前，不要优先拆这块
- 如果必须拆，也只允许把“辅助函数”移出，`chat:send` handler 本体先留在 `main.ts`

#### L. Channel Setup / QR Login / Sessions

风险来源：

- CLI 输出解析非常脆弱
- 二维码 ASCII 检测、URL 自动打开、超时语义都容易被破坏
- 同时依赖 registry、shell、Gateway WS、renderer event

结论：

- 这是第二阶段后期任务，不是第一阶段任务

#### M. App Lifecycle + Window + Tray

涉及：

- `createWindow`
- `createTray`
- `app.whenReady()`
- `second-instance`
- `before-quit`
- `window-all-closed`
- `activate`

结论：

- 保持在 `main.ts` 顶层附近
- 最多只提取辅助常量或菜单模板
- 不要先把它们拆到多个文件

## 4. 推荐的目标目录结构

第一阶段不要把目录设计得太花。以下结构已经足够：

```text
packages/desktop/electron/
  main.ts
  preload.ts
  doctor.ts
  gateway-ws.ts
  openclaw-config.ts
  runtime-preferences.ts
  shell-utils.ts
  local-daemon.ts
  memory-client.ts
  file-dialogs.ts
  internal-hook.ts
  daemon-watchdog.ts
  ipc/
    register-app-handlers.ts
    register-setup-handlers.ts
    register-gateway-handlers.ts
    register-memory-handlers.ts
```

解释：

- `main.ts` 保留为唯一入口文件
- 先拆“工具函数”和“客户端函数”
- 等这些稳定后，再拆 `ipc/register-*.ts`
- `ipc/` 目录只放“注册器”，不要在第一阶段额外引入 controller/service/repository 分层

## 5. 推荐拆分顺序

### Phase 0: 只做基线，不改逻辑

目标：确认重构前后行为一致

必须完成：

1. 记录 `main.ts` 当前行数和 handler 清单
2. 记录关键全局状态列表
3. 列出高风险区域，明确暂不触碰

这一步当前已经由本文件完成。

### Phase 1: 提取纯工具函数

顺序建议：

1. `runtime-preferences.ts`
2. `shell-utils.ts`
3. `file-dialogs.ts`
4. `internal-hook.ts`

操作方式：

1. 原样复制函数到新文件
2. 导出这些函数
3. `main.ts` 改为 import 调用
4. 不改调用参数、不改函数签名，除非为了解掉对全局变量的直接引用

### Phase 2: 提取客户端封装

顺序建议：

1. `local-daemon.ts`
2. `memory-client.ts`
3. `daemon-watchdog.ts`

规则：

- 只提取 client/helper，不立即搬动整组 IPC
- 确保新文件通过依赖注入拿到需要的变量，不依赖隐式全局

### Phase 3: 提取 IPC 注册器

优先级：

1. `register-memory-handlers.ts`
2. `register-app-handlers.ts`
3. `register-setup-handlers.ts`
4. `register-gateway-handlers.ts`

推荐模式：

```ts
export function registerMemoryHandlers(deps: MemoryHandlerDeps) {
  ipcMain.handle('memory:search', async (_e, query: string) => {
    return deps.callMcp('awareness_recall', {
      semantic_query: query,
      keyword_query: query,
      detail: 'full',
      limit: 15,
    });
  });
}
```

重点：

- handler 体可以先一字不改复制过去
- 先把“位置”拆开，再考虑减少重复

### Phase 4: 中高风险区谨慎推进

只有在前 3 个阶段稳定之后，才考虑：

1. OpenClaw config merge 区
2. Gateway runtime 区
3. Channel 管理区
4. chat 区

如果没有覆盖这些区域的验证手段，就停止在 Phase 3，不要继续硬拆。

## 6. 每次重构必须验证的行为清单

即使只是“搬代码”，每次也至少手动验证以下路径：

1. 应用启动正常，窗口可打开
2. macOS 下关闭窗口不会直接退出
3. Setup 页面环境检测能返回结果
4. Gateway 状态可读取
5. Memory 页面能正常读取数据或正常报错
6. 文件选择器能打开
7. 配置导入/导出不崩溃
8. 聊天发送至少能跑通一次

如果改动触及对应模块，还要补充专项验证：

- 改 shell utilities：验证 Node/OpenClaw 检测、gateway status、upgrade 检查
- 改 daemon client：验证 daemon health、memory search、startup ensure runtime
- 改 Gateway：验证自动启动、stop/restart、失败提示
- 改 channel：验证 QR 登录、session list、history、reply

## 7. main.ts 最终应该保留什么

即使拆分完成，`main.ts` 也不应该变成空壳。它仍然应该保留：

1. Electron 入口初始化
2. 单例状态定义
3. `createWindow()`
4. `createTray()` 或至少 tray 启动入口
5. `app.whenReady()` 和所有 `app.on(...)`
6. 各类 `registerXxxHandlers(...)` 的集中调用

目标不是消灭 `main.ts`，而是让它退化成“入口编排文件”。

## 8. 不推荐的错误重构方式

以下做法看起来高级，但当前阶段都不应该采用：

1. 一次性把 4000 行拆成 15 个文件
2. 引入 IoC 容器或复杂 DI 框架
3. 把所有 handler 改成 class method
4. 顺手统一返回格式、错误格式、命名风格
5. 顺手把 shell 命令封装成“更优雅”的 DSL
6. 把 config merge 替换为通用 deep merge 库
7. 把 channel/chat 逻辑一起重写为 event bus

这些都不是“低风险重构”，而是“重写”。

## 9. 给后续开发者的执行模板

如果你要开始拆 `main.ts`，请按这个模板执行：

1. 先读本文件
2. 选一个低风险责任块
3. 新建目标文件
4. 原样 copy/paste 原函数
5. 在 `main.ts` 中改成 import 调用
6. 不改行为，只修复编译错误
7. 手动验证该责任块相关路径
8. 单独提交，不混入其他功能修改

如果你发现自己“顺手优化了好几个地方”，说明你已经偏离了这份文档。

## 10. 当前结论

对 `packages/desktop/electron/main.ts` 的正确策略不是大手术，而是分三层推进：

1. 先拆工具函数
2. 再拆 client/helper
3. 最后才拆 IPC 注册

`chat`、`channel`、`app lifecycle` 三块暂时不要优先动。

只要遵守这个顺序，重构是可做的；如果跳过顺序，风险会立刻从“整理文件”升级为“改坏产品”。