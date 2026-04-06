# OpenClaw Gateway Windows 修复审查报告（2026-04-07）

## 1. 文档信息
- 日期：2026-04-07
- 使用对象：CTO 审查
- 仓库：AwarenessClaw（packages/desktop）
- 范围：Windows 下 Gateway 启动与设置页反复“修复失败”问题

## 2. 执行摘要
本次问题属于产品可靠性问题，不是用户操作问题。

核心结论：
- 当前修复链路在执行 openclaw gateway start 后，可能直接返回成功，但 Gateway 实际仍不可用。

主要诱因：
- 启动与检查链路更偏向“快速进入界面”，弱化了“运行时就绪确认”。
- Gateway 存在多条修复路径，成功判定标准不一致。
- Windows 运行环境下可能在插件引导阶段失败（如 spawn npx ENOENT），目前自动自愈不完整。

业务影响：
- 非技术用户容易进入“点修复 -> 仍不可用 -> 再点修复”的循环。
- 用户对“修复成功=可用”的预期被破坏，信任感下降。

## 3. 事件描述
用户现象：
- 在设置页多次点击 Gateway 修复/启动，状态仍异常。
- 用户预期是“一键修复”，不应依赖终端命令。

环境信息：
- 操作系统：Windows 10.0.22621
- OpenClaw：2026.4.5（3e72c03）

## 4. 已验证运行证据
### 4.1 命令提示成功但运行时未就绪
观测命令：
- openclaw gateway status --json
- openclaw gateway start
- openclaw gateway status --json

观测结果：
- start 输出“重启登录项”类成功信息。
- 但后续状态仍可能是：
  - runtime.status = unknown
  - port.status = free
  - rpc.ok = false

解释：
- 命令执行成功不等于服务已就绪。

### 4.2 日志中出现环境级崩溃信号
日志文件：C:\tmp\openclaw\openclaw-2026-04-07.log

典型错误：
- Error: spawn npx ENOENT
- Failed to start CLI: Error: Cannot find module '@buape/carbon'

解释：
- 至少存在一类 Windows 路径下，daemon/plugin 引导会因命令不可见或全局依赖不完整而失败。

### 4.3 回退模式下出现健康信号冲突
某次状态同时出现：
- port.status = busy
- rpc.ok = true
- 18789 端口存在监听
- 但 health.healthy = false（stale pid）

解释：
- 当前健康判定过于严格，可能把“实际可用”的状态误判为失败。

## 5. 代码级发现
## 5.1 P0：Doctor 的 fixGatewayStart 存在“假成功”风险
文件：packages/desktop/electron/doctor/checks-infra.ts
- fixGatewayStart 在 openclaw gateway start 后直接返回成功。
- 未强制进行 RPC/端口二次验证。

影响：
- 界面显示“修复成功”，Gateway 实际仍不可用。

## 5.2 P0：Gateway 健康判定在回退模式下过严
文件：packages/desktop/electron/main.ts
- isGatewaySnapshotHealthy 当前要求同时满足：
  - rpc.ok == true
  - health.healthy == true
  - runtime running 或 port busy

影响：
- 即使已有监听且 RPC 成功，也可能因 stale pid 被判失败。

## 5.3 P1：设置页与 Doctor 的修复路径不一致
文件：
- packages/desktop/electron/ipc/register-gateway-handlers.ts
- packages/desktop/electron/doctor/checks-infra.ts

现状：
- 设置页 Gateway 启动走 startGatewayWithRepair（链路更完整）。
- Doctor 修复走 fixGatewayStart（链路更简化）。

影响：
- 用户从不同入口修复，结果不一致。

## 5.4 P1：启动阶段存在“超时放行”
文件：packages/desktop/src/App.tsx
- 启动检查采用 20 秒超时 race，超时结果映射为 ok: true。

影响：
- 用户可先进入界面，但运行时并未稳定，导致“进入后再报错/再修复”。

## 5.5 P1：Setup 链路存在“成功但未硬就绪”放行
文件：packages/desktop/electron/ipc/register-setup-handlers.ts
- 插件安装可能返回：method = config-only（首次运行再安装）。
- daemon 启动可能返回：success = true 且 pending = true。

影响：
- 首次安装后仍可能出现 plugin/daemon/gateway 红项。

## 5.6 P2：设置页默认不自动执行 Doctor
文件：packages/desktop/src/pages/Settings.tsx
- Doctor 在页面加载时不自动运行。

影响：
- 非技术用户不易理解“为什么仍不可用”。

## 6. 根因分析
本问题由多次改动叠加形成，不是单一提交导致。

### 6.1 功能根因
- 成功标准漂移：命令成功 与 服务可用 被混用。
- 多链路并存且缺少统一就绪契约。

### 6.2 架构根因
- 为降低冷启动卡顿，部分检查从关键路径移出或放宽。
- 性能优化优先后，可靠性判定未同步收敛。

### 6.3 平台根因（Windows）
- 登录项/会话/服务上下文差异会改变命令可见性。
- 全局包完整性问题会导致 OpenClaw 运行时模块加载失败。

## 7. 普通用户影响评估
会遇到，且在 Windows 普通用户场景下风险较高。

原因：
- 用户依赖 UI 修复，不会也不应使用终端。
- UI 当前可能在“未真实就绪”时提示成功。
- npx 与全局包完整性等环境问题对用户不可见。

## 8. 提交时间线（归因）
关键提交：
- 41714e4（2026-04-02，edwin-hao-ai）：引入 setup/runtime doctor 基础链路。
- fd39cca（2026-04-05，EverestAn）：强化 setup，引入 daemon pending 放行。
- 3cbbabf（2026-04-06，edwin-hao-ai）：引入启动 20 秒超时 race，减少冷启动阻塞。
- ca28ce0（2026-04-06，edwin-hao-ai）：为性能将 channel-bindings 移出启动 auto-fix。
- 04a43e8（2026-04-06，edwin-hao-ai）：改为后台执行启动检查，移除启动阻塞页。

结论：
- 当前问题是“性能优化叠加 + 就绪标准不统一”共同造成。

## 9. 修复建议
## 9.1 立即修复（P0）
1. 统一 Gateway 修复成功标准。
   - 最低门槛：端口监听 + rpc.ok = true。
2. 让 Doctor 的 fixGatewayStart 复用 startGatewayWithRepair 或统一校验器。
3. 所有修复返回前必须做后验检查，不通过不得返回 success。

## 9.2 近期加固（P1）
1. 放宽回退模式健康判定，避免 stale pid 单点否决可用状态。
2. 将启动超时语义从 ok=true 改为 warming 状态。
3. Setup 阶段不要把 config-only/pending 当作最终就绪。

## 9.3 Windows 自愈（P1）
1. 识别 spawn npx ENOENT 后，自动触发环境修复路径。
2. 增加全局包完整性检测，模块缺失时引导一键自愈。

## 9.4 产品与文案护栏（P2）
1. 在设置页明确展示失败原因：
   - 命令成功但 RPC 未就绪
   - 环境缺命令或模块
2. 增加“一键深度修复”，分阶段展示并带最终验收结果。

## 10. 验证计划
必须覆盖的回归场景：
1. Windows 下 gateway start 返回成功，但 runtime 仍 unknown。
2. listener busy + rpc.ok=true + health.healthy=false 场景。
3. Setup 中 plugin=config-only 与 daemon=pending 后的首启一致性。
4. 启动超时路径不允许静默映射为 ok=true。
5. Doctor 修复在就绪校验失败时必须返回失败。

验收标准：
- 未通过就绪校验不得提示成功。
- 同一根因不再出现用户可见的“重复修复循环”。

## 11. 影响面
潜在影响模块：
- 设置页 Gateway 控制
- 启动时运行时检查
- Setup 安装完成判定
- Chat 前置 Gateway 就绪流程

主要文件：
- packages/desktop/electron/doctor/checks-infra.ts
- packages/desktop/electron/main.ts
- packages/desktop/electron/ipc/register-gateway-handlers.ts
- packages/desktop/electron/ipc/register-runtime-health-handlers.ts
- packages/desktop/electron/ipc/register-setup-handlers.ts
- packages/desktop/src/App.tsx
- packages/desktop/src/pages/Settings.tsx

## 12. 最终结论
这是运行时编排与就绪语义不一致导致的可靠性缺口。
该问题可在普通 Windows 用户中复现，应按产品缺陷处理，而非用户操作问题。

最有效的修复路径是：
- 建立单一权威就绪契约（监听 + RPC），
- 所有启动/修复入口统一按该契约验收后再返回成功。
