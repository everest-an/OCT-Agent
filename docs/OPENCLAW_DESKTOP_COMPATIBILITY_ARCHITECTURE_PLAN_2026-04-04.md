# AwarenessClaw Desktop 兼容性架构升级方案（2026-04-04）

## 1. 目标与边界

### 1.1 目标

1. 在产品层实现稳定兼容 Windows、macOS、Linux，减少“按频道逐个修补”。
2. OpenClaw 官网升级后，桌面端可通过能力探测和契约校验自动适配，避免大面积回归。
3. 用户体验从“失败后人工排错”升级为“连接前自检 + 自动修复 + 友好提示 + 可观测诊断”。

### 1.2 非目标

1. 不 fork OpenClaw。
2. 不重写 OpenClaw Gateway 或频道插件。
3. 不在首阶段改动 chat/gateway 高风险业务语义，只做兼容层重构与编排层治理。

## 2. 现状深层根因分析

### 2.1 现象

1. 同一频道在 CLI 终端可用，但在桌面端一键流程中失败。
2. 同一版本昨天可用、今天不可用，故障随机性高。
3. 失败常表现为 spawn ENOENT、PATH 丢失、插件加载耗时超时、Gateway 状态漂移。

### 2.2 根因树

1. 执行上下文漂移。
2. 平台执行语义差异。
3. 服务生命周期和时序竞态。
4. 上游能力变化快，缺少契约层。
5. 观测不足，故障归因依赖人工读日志。
6. 质量保障偏功能测试，缺少跨平台集成门禁。

### 2.3 代码证据

1. 运行时和编排逻辑集中在 [packages/desktop/electron/main.ts](packages/desktop/electron/main.ts#L73)。
2. shell 与 PATH 处理集中在 [packages/desktop/electron/shell-utils.ts](packages/desktop/electron/shell-utils.ts#L19)。
3. 频道登录流在 [packages/desktop/electron/ipc/channel-login-flow.ts](packages/desktop/electron/ipc/channel-login-flow.ts#L12)。
4. 频道 setup 编排在 [packages/desktop/electron/ipc/register-channel-setup-handlers.ts](packages/desktop/electron/ipc/register-channel-setup-handlers.ts#L4)。
5. 本地 daemon 启停在 [packages/desktop/electron/local-daemon.ts](packages/desktop/electron/local-daemon.ts#L92)。
6. 动态频道注册表在 [packages/desktop/electron/channel-registry.ts](packages/desktop/electron/channel-registry.ts#L117)。

## 3. 目标架构（产品级修复）

### 3.1 架构原则

1. 统一执行层。
2. 统一健康门禁。
3. 统一编排状态机。
4. 统一诊断与错误语义。
5. 上游升级先探测后启用。

### 3.2 分层模型

1. Compatibility Contract Layer。
2. Runtime Execution Layer。
3. Service Supervisor Layer。
4. Channel Orchestration Layer。
5. UX Resilience Layer。
6. Quality Gate Layer。

## 4. 关键设计

### 4.1 Compatibility Contract Layer

1. 启动时生成能力快照。
2. 快照内容。
3. 存储路径建议。
4. 执行策略。

### 4.2 Runtime Execution Layer

1. ProcessRunner 统一实现。
2. CommandResolver 统一解析。
3. EnvProvider 统一提供环境。
4. 对外只暴露一套 API。

### 4.3 Service Supervisor Layer

1. GatewaySupervisor。
2. LocalDaemonSupervisor。
3. Startup Guard。
4. 只输出结构化状态。

### 4.4 Channel Orchestration Layer

1. 一键连接统一状态机。
2. 建议状态。
3. 每一步定义输入、输出、可恢复动作。
4. 失败不直接结束，优先补救再失败。

### 4.5 UX Resilience Layer

1. 错误文案由错误码映射。
2. 进度必须可视化。
3. 失败后提供一键修复动作。
4. 用户可导出诊断包。

### 4.6 Quality Gate Layer

1. 跨平台集成测试矩阵。
2. OpenClaw 升级兼容流水线。
3. 发布门禁。

## 5. OpenClaw 升级适配机制

### 5.1 版本策略

1. 维护 support window。
2. 引入兼容性特性开关。
3. 升级后先跑探测，不通过则降级使用稳定路径。

### 5.2 自动适配流程

1. Nightly 拉取 latest OpenClaw。
2. 执行 capability snapshot。
3. 运行 smoke matrix。
4. 生成兼容报告并自动创建内部任务。

### 5.3 兼容策略

1. 参数变化。
2. 频道枚举变化。
3. 插件入口变化。
4. 服务行为变化。

## 6. 三端兼容设计

| 维度 | Windows Native | macOS | Linux |
|------|----------------|-------|-------|
| 命令执行 | cmd/PowerShell shim 与 .cmd 解析，优先 resolver | bash/zsh 兼容，禁止 profile 污染 | bash 兼容，禁止 profile 污染 |
| 服务模式 | Scheduled Task + Startup fallback 双路径 | LaunchAgent | systemd user service |
| PATH 策略 | 用户 PATH + 常见 Node 路径 + 运行时补丁 | 用户 PATH + Homebrew/NVM 探测 | 用户 PATH + distro 常见路径 |
| 频道登录 | 非 TTY 兼容、预热门禁 | 非 TTY 兼容 | 非 TTY 兼容 |
| 诊断输出 | 结构化 + 兼容任务计划信息 | 结构化 + 权限信息 | 结构化 + systemd 信息 |

## 7. 落地计划（分阶段）

### Phase 0（1 周）观测先行

1. 新增统一错误码与诊断事件。
2. 为 channel setup、gateway、daemon 增加 traceId。
3. 定义成功率指标与基线。

### Phase 1（1.5 周）统一执行层

1. 收敛所有 shell/spawn 调用到 ProcessRunner。
2. 统一 CommandResolver 与 EnvProvider。
3. 完成主流程回归。

### Phase 2（1.5 周）服务监督层

1. 落地 GatewaySupervisor 与 LocalDaemonSupervisor。
2. 引入 startup guard。
3. 所有频道流程接入门禁。

### Phase 3（2 周）频道编排状态机

1. 把一键连接改为显式状态机。
2. 每个状态定义 recover 动作。
3. 对 WeChat/WhatsApp/Signal/Telegram 做模板化。

### Phase 4（1 周）升级兼容自动化

1. 增加 nightly latest 验证。
2. 引入 capability snapshot 差异报告。
3. 发布门禁接入 CI。

### Phase 5（持续）体验优化

1. 统一错误文案与修复按钮。
2. 诊断包导出。
3. 失败聚类和自动修复策略迭代。

## 8. 验收标准

### 8.1 用户体验指标

1. 频道首次连接成功率 >= 95%。
2. 可自动修复失败占比 >= 80%。
3. 连接流程中无“无反馈等待”超过 8 秒。

### 8.2 质量指标

1. 三端 smoke 全绿后才允许发版。
2. OpenClaw latest nightly 连续 3 天通过。
3. P0 回归平均修复时长 < 24 小时。

### 8.3 兼容指标

1. 最新 OpenClaw 版本上线 48 小时内给出兼容状态。
2. 参数和行为变更可被 capability snapshot 自动识别。

## 9. 风险与应对

1. 重构范围大。
2. 上游变化频繁。
3. Windows 环境碎片化。

对应策略。

1. 按 docs/structures.md 的低风险拆分红线推进。
2. 先加观测后改行为。
3. 用 feature flag 控制新旧路径并支持灰度回滚。

## 10. 组织与流程建议

1. 设立 Runtime 负责人。
2. 设立 Channel Orchestration 负责人。
3. 每周固定做一次 latest OpenClaw 兼容评审。
4. 每次触达高风险文件必须附上三端回归结果。

## 11. 与现有代码映射的首批改造点

1. 在 [packages/desktop/electron/shell-utils.ts](packages/desktop/electron/shell-utils.ts#L19) 收敛执行入口。
2. 在 [packages/desktop/electron/main.ts](packages/desktop/electron/main.ts#L237) 将 daemon/gateway 预热改为 supervisor 对象。
3. 在 [packages/desktop/electron/ipc/register-channel-setup-handlers.ts](packages/desktop/electron/ipc/register-channel-setup-handlers.ts#L122) 替换分支判断为状态机驱动。
4. 在 [packages/desktop/electron/channel-registry.ts](packages/desktop/electron/channel-registry.ts#L117) 接入 capability snapshot 结果，禁止静态假设。
5. 在 [packages/desktop/src/test/channel-setup-handler.test.ts](packages/desktop/src/test/channel-setup-handler.test.ts#L77) 扩展为跨平台场景测试模板。

## 12. 结论

当前问题不是“OpenClaw 原生不可用”，而是“桌面产品层缺少统一兼容架构”。

本方案通过统一执行层、统一门禁、统一状态机、统一诊断和升级自动适配，把问题从被动修补升级为系统治理，目标是在三端实现稳定、可升级、可观测、可恢复的用户体验。