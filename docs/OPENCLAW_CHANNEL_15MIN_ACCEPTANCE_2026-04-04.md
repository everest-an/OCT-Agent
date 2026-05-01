# OpenClaw 通道 15 分钟验收脚本（2026-04-04）

## 1. 范围

1. 验证本轮通道体验相关改动。
2. 断开后重连不会因为 plugin already exists 直接失败。
3. 通道连接遇到 failed to load 时会自动修复一次并重试。
4. OpenClaw 帮助输出格式变化后，通道参数仍可正常使用。
5. 保存链路与连接链路的插件安装依赖解析保持一致。

## 2. 时间预算

1. 总时长：15 分钟。
2. 环境检查：2 分钟。
3. 核心流程检查：10 分钟。
4. 结果记录：3 分钟。

## 3. 前置条件

1. OCT-Agent 桌面端可正常启动。
2. OpenClaw CLI 已安装且可在终端执行。
3. 至少有一个可用于登录测试的通道账号。
4. 测试机器网络可用。

## 4. 快速环境检查（2 分钟）

1. 启动应用并进入 Channels 页面。
2. 在终端执行：
openclaw --version
openclaw channels add --help
openclaw plugins list
3. 通过标准：
4. 命令均可正常返回。
5. Channels 页面可渲染通道列表。

## 5. 核心体验检查（10 分钟）

### 用例 A：首次连接流程顺滑（4 分钟）

1. 在 Channels 页面选择一个一键连接通道（建议 WhatsApp 或 Signal）。
2. 发起连接流程并完成扫码/登录。
3. 观察状态文案变化。
4. 在终端执行：
openclaw channels list
5. 通过标准：
6. UI 展示 connecting 后成功，或展示明确的 pending confirmation 提示。
7. channels list 中该通道状态为 configured 或 linked 或 enabled。

### 用例 B：重连不会被 already exists 阻断（3 分钟）

1. 在 UI 中断开同一通道。
2. 立即重新连接该通道。
3. 通过标准：
4. 不会因插件已存在而直接失败。
5. 连接流程可继续并完成。

### 用例 C：自动修复重试路径（3 分钟）

1. 在可能触发插件加载失败的环境下发起连接。
2. 启动通道连接流程。
3. 观察重试前是否出现修复状态。
4. 通过标准：
5. UI 能展示 repairing plugin 状态并自动重试连接。
6. 若重试成功，最终进入成功或 pending confirmation。
7. 若重试失败，错误提示具备可操作性，而不是仅原始堆栈。

## 6. 参数动态行为抽查（可选，若有剩余时间）

1. 在 Channels 页面打开多字段通道的配置表单（建议 Slack 或 Matrix）。
2. 检查必填字段是否完整且可填写。
3. 通过标准：
4. 字段布局与当前 OpenClaw channels add --help 对齐。
5. 不出现因解析差异导致的必填字段缺失。

## 7. CLI 一致性检查（2 分钟）

1. 任一通道连接成功后，在终端执行：
openclaw channels list
openclaw agents bindings
2. 通过标准：
3. 通道出现在列表中，并绑定到 main agent 或预期 agent。

## 8. 结果记录模板

1. 构建包版本：
2. 测试环境：
3. 测试通道：
4. 用例 A 结果：通过或失败
5. 用例 B 结果：通过或失败
6. 用例 C 结果：通过或失败
7. 参数动态抽查：通过或失败
8. 备注与截图：

## 9. 回滚触发条件

1. 任一核心用例连续两次重试仍失败。
2. UI 超过 8 秒无状态更新且无结果反馈。
3. UI 显示已连接，但 channels list 长期为空或未更新。
