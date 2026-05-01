# OCT-Agent Desktop 通道兼容性升级方案（仅通道改造，2026-04-04）

## 0. 范围锁定（强约束）

本方案只允许改通道相关模块，不改通用运行时层。

允许改动：

1. [packages/desktop/electron/channel-registry.ts](packages/desktop/electron/channel-registry.ts)
2. [packages/desktop/electron/ipc/register-channel-config-handlers.ts](packages/desktop/electron/ipc/register-channel-config-handlers.ts)
3. [packages/desktop/electron/ipc/register-channel-setup-handlers.ts](packages/desktop/electron/ipc/register-channel-setup-handlers.ts)
4. [packages/desktop/electron/ipc/channel-login-flow.ts](packages/desktop/electron/ipc/channel-login-flow.ts)
5. [packages/desktop/src/test/channel-setup-handler.test.ts](packages/desktop/src/test/channel-setup-handler.test.ts)

不在本方案改动范围：

1. [packages/desktop/electron/shell-utils.ts](packages/desktop/electron/shell-utils.ts)
2. [packages/desktop/electron/main.ts](packages/desktop/electron/main.ts)
3. [packages/desktop/electron/local-daemon.ts](packages/desktop/electron/local-daemon.ts)
4. chat/gateway 语义与流程

注：如需在主进程做依赖注入，只允许最小接线，不允许新增运行时策略。

## 1. 目标

1. 通道参数与依赖全部动态化，不依赖固定硬编码列表。
2. 跟随 OpenClaw 官方通道机制升级后，桌面端自动适配并保持可用。
3. 用户侧通道连接流程顺滑，失败优先自动修复。

## 2. 官方机制对照（Web Search + 官方代码）

### 2.1 官方 CLI 与文档结论

1. openclaw channels add --help 是通道参数的官方真源，包含每个通道可用 flags。
2. openclaw channels login --channel <id> 是官方交互登录入口。
3. openclaw plugins install / uninstall / update 是官方插件生命周期入口。
4. openclaw plugins inspect <id> --json 提供 install.spec，可用于恢复时动态反查安装来源。
5. openclaw channels 文档明确建议用 add/list/status/login 的组合管理通道。

### 2.2 官方仓库机制结论

1. 官方通过 channel-catalog + plugin manifest 管理通道安装元数据（npmSpec 等）。
2. 官方通过 cli-startup-metadata 预生成 channelOptions，作为 CLI 启动时通道选项来源。
3. 通道安装流程使用 catalog entry 的 install.npmSpec，而不是业务层硬编码包名。
4. 通道解析流程以 catalog/plugin registry 为核心，支持别名与后续扩展。

## 3. 设计原则（仅通道域）

1. 单一事实来源：通道参数来自 channels add --help，依赖来源来自 channel-catalog 与 plugins inspect --json。
2. 前端/主进程同一注册表：所有通道元数据统一走 channel-registry。
3. 恢复策略参数化：修复失败插件时，优先动态反查 install.spec，不手写包名映射。
4. 官方优先：连接编排严格沿用 add/login/bind/list 官方链路。

## 4. 通道参数化与依赖动态化方案

### 4.1 参数动态化

1. 启动与通道页面刷新时，解析 openclaw channels add --help。
2. 将 channel 枚举与字段映射写入 channel-registry 运行态缓存。
3. 表单渲染、CLI flags 生成、saveStrategy 判断均从 registry 获取。

### 4.2 依赖动态化

依赖解析优先级：

1. channel-registry 中的 pluginPackage（来自官方 catalog npmSpec）。
2. openclaw plugins inspect <pluginId> --json 的 install.spec。
3. 以上都拿不到时，不做强制修复，避免误装非通道插件。

### 4.3 连接编排（官方链路）

1. plugins install <spec>
2. 按策略执行 channels add --channel <id>（官方需先配置的通道）
3. channels login --channel <id> --verbose
4. agents bind --agent main --bind <id>
5. channels list 确认 configured/linked/enabled

### 4.4 失败自动修复（仅通道插件）

1. 捕获 failed to load / PluginLoadFailureError。
2. 解析失败 pluginId。
3. 动态解析 install spec。
4. plugins uninstall --force <id>。
5. plugins install <dynamic spec>。
6. 仅重试一次 login，避免死循环。

## 5. 三端兼容（通道维度）

| 维度 | Windows | macOS | Linux |
|------|---------|-------|-------|
| 参数来源 | channels add --help 动态解析 | 同左 | 同左 |
| 依赖来源 | channel-catalog + plugins inspect --json | 同左 | 同左 |
| 登录流程 | channels login --verbose | 同左 | 同左 |
| 修复动作 | uninstall/install + login retry | 同左 | 同左 |
| 结果确认 | channels list 状态确认 | 同左 | 同左 |

## 6. 升级适配机制（跟随 OpenClaw 官方升级）

1. 每次 app 启动自动重建通道能力快照：
   - channels add --help
   - dist/channel-catalog.json
   - dist/cli-startup-metadata.json
2. 若官方新增通道或参数，registry 自动吸收并体现在 UI 与 CLI 参数构造。
3. 若官方调整插件安装来源，修复路径通过 plugins inspect --json 自动跟随。
4. 发布前至少跑一次 latest OpenClaw 的通道 smoke，验证 add/login/bind/list 四步链路。

## 7. 验收标准（仅通道）

1. 新增或变更通道参数时，无需改硬编码即可在 UI 表单与保存流程生效。
2. 通道插件加载失败时，自动修复成功率 >= 80%。
3. 通道首次连接成功率 >= 95%。
4. OpenClaw 升级后 48 小时内完成通道兼容验证报告。

## 8. 首批改造映射

1. [packages/desktop/electron/channel-registry.ts](packages/desktop/electron/channel-registry.ts)：参数/依赖真源统一入口。
2. [packages/desktop/electron/ipc/register-channel-config-handlers.ts](packages/desktop/electron/ipc/register-channel-config-handlers.ts)：保存与 add 流程完全走 registry 动态数据。
3. [packages/desktop/electron/ipc/register-channel-setup-handlers.ts](packages/desktop/electron/ipc/register-channel-setup-handlers.ts)：登录失败修复链路改为动态 install.spec 解析。
4. [packages/desktop/electron/ipc/channel-login-flow.ts](packages/desktop/electron/ipc/channel-login-flow.ts)：保持官方 login 行为与 QR/深链解析。
5. [packages/desktop/src/test/channel-setup-handler.test.ts](packages/desktop/src/test/channel-setup-handler.test.ts)：增加动态依赖解析与自动修复回归测试。

## 9. 结论

本版本方案已按你的要求收敛为“只改通道”。

核心能力是：

1. 参数动态化（来自官方 CLI help）。
2. 依赖动态化（来自官方 catalog + inspect）。
3. 连接流程官方化（add/login/bind/list）。

这样在 OpenClaw 官方升级后，桌面端可以通过通道层自动适配，持续保障客户通道连接顺畅。
