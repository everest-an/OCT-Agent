# OCT-Agent Tier-1 通道三端 Smoke Matrix（2026-04-07）

## 1. 目标

- 这份文档是 OpenClaw 升级后最小发布验证脚本，不替代全量 deep smoke。
- 目标只覆盖 OCT-Agent 当前必须守住的 tier-1 通道最小闭环：Telegram、WhatsApp、Discord、微信。
- 每次升级 OpenClaw、升级 `@tencent-weixin/openclaw-weixin`、修改 channel setup/login/bind 逻辑后，都要重跑这份矩阵。
- 这里的 tier-1 是 OCT-Agent 的发布门槛，不等同于 upstream docs 的默认展示顺序。

## 2. 为什么最小集包含微信

- Telegram、WhatsApp、Discord 都有 OpenClaw 官方通道文档，且是三端可跑的核心聊天通道。
- 微信虽然不在 docs.openclaw.ai 的核心频道列表里，但 `@tencent-weixin/openclaw-weixin` 是当前实际官方插件路径，且已经是 OCT-Agent Channels 页的一等入口。
- 对我们的客户来说，微信不是“高级附加通道”，而是必须跟 Telegram、WhatsApp、Discord 一起守住的升级回归面。
- 因此发布前最小 smoke matrix 固定为 4 x 3，而不是只看 upstream docs 的默认 tier。

## 3. 执行前提

- 三台测试机或三套干净环境分别覆盖 Windows、macOS、Linux。
- Desktop 当前构建通过：`cd packages/desktop && npm run build`。
- OpenClaw 版本、Desktop commit、Node 版本在开始前记录到结果表。
- Telegram 已准备 BotFather token。
- WhatsApp 已准备可扫码账号和至少一个真实联系人或第二设备。
- Discord 已准备 bot token、owner user ID、server ID，并确认 privileged intents 与 DM 开关正确。
- 微信已确认 OpenClaw 主版本满足 `@tencent-weixin/openclaw-weixin` 当前兼容线；`2.x` 线要求 OpenClaw `>=2026.3.22`。
- 所有通道都要求 Gateway 可启动；如果宿主机有代理，WhatsApp 必须记录 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 状态。

## 4. 通用通过标准

- Channels UI 能发起连接，不出现原始堆栈或无状态卡死。
- `openclaw channels list` 能看到该通道处于 `configured`、`linked`、`enabled` 或等价健康状态。
- `openclaw agents bindings` 能看到该通道已绑定到 `main` 或本次预期 agent。
- 第一条真实入站消息要么触发 pairing，要么直接收到回复，不能静默丢失。
- Gateway 重启后，第二条消息仍能工作，不能要求重新做完整 setup。
- 不允许出现 `No response`、60 秒以上无状态更新、无限 reconnect、或“UI 成功但 CLI 看不到通道”的假成功。

## 5. 计划矩阵

| Channel | Windows | macOS | Linux | 核心链路 | 重点观察风险 |
|---|---|---|---|---|---|
| Telegram | Required | Required | Required | token save -> gateway start -> first DM -> pairing approve -> second DM -> restart verify | token 已保存但不产出 pairing code；重复投递；重连后假在线 |
| WhatsApp | Required | Required | Required | QR login -> first inbound -> pairing approve if needed -> reply -> restart verify | ASCII QR 截断；代理环境握手失败；重启后 listener 丢失 |
| Discord | Required | Required | Required | bot token + IDs -> gateway start -> DM bot -> pairing approve -> second DM -> restart verify | intents/DM 权限漏配；Socket Mode 假连接；重启后 DM 静默掉线 |
| WeChat | Required | Required | Required | plugin install -> QR login -> gateway restart -> first DM -> reply -> restart verify | host/plugin 版本漂移；plugin entry 被关掉；登录完成但 gateway 未接管 |

## 6. 单通道执行脚本

### 6.1 Telegram

适用范围：Windows、macOS、Linux。

步骤：

1. 在 Desktop 或 `openclaw.json` 中保存 Telegram bot token，不要调用 `openclaw channels login telegram`。
2. 启动 Gateway。
3. 用 owner Telegram 账号给 bot 发送 `telegram smoke ping`。
4. 执行：

```bash
openclaw pairing list telegram
openclaw pairing approve --channel telegram <CODE> --notify
openclaw channels list
openclaw agents bindings
```

5. 再发一条 `telegram smoke after approve`。
6. 重启 Gateway。
7. 再发一条 `telegram smoke after restart`。

通过标准：

- 第一条 DM 后 1 分钟内能看到待审批 pairing code。
- approve 成功后同一 DM 能收到正常回复。
- 重启 Gateway 后仍能继续回复，不要求重新保存 token。

重点证据：

- pairing list 输出。
- channels list 中的 Telegram 状态。
- agents bindings 中的 Telegram 绑定。
- 首次回复与重启后回复截图。

### 6.2 WhatsApp

适用范围：Windows、macOS、Linux。

步骤：

1. 在 Desktop 发起 WhatsApp 一键连接，或执行：

```bash
openclaw channels login --channel whatsapp
```

2. 确认前端或终端展示完整 ASCII QR，并用测试账号扫码。
3. 启动或重启 Gateway。
4. 用真实联系人或第二设备发送 `whatsapp smoke ping`。
5. 若当前策略是 `dmPolicy=pairing`，执行：

```bash
openclaw pairing list whatsapp
openclaw pairing approve --channel whatsapp <CODE> --notify
```

6. 再发送 `whatsapp smoke after approve`。
7. 执行：

```bash
openclaw channels list
openclaw agents bindings
```

8. 重启 Gateway。
9. 再发送 `whatsapp smoke after restart`。

通过标准：

- QR 不截断，扫码后 `channels list` 显示 `linked` 或等价健康状态。
- 第一条真实消息不会静默丢失。
- pairing 模式下可正常 approve，非 pairing 模式下能直接回复。
- Gateway 重启后无需重新扫码，仍能回复第二条消息。

重点证据：

- QR 展示截图。
- pairing list 输出（如启用 pairing）。
- channels list 中的 WhatsApp 状态。
- 重启前后两条回复截图。

平台注意：

- 如果宿主机带企业代理，必须把代理变量记录进结果表；WhatsApp 的很多失败都和代理握手有关。

### 6.3 Discord

适用范围：Windows、macOS、Linux。

步骤：

1. 在 Discord Developer Portal 准备 bot token，并确认 `Message Content Intent` 已开启。
2. 确认测试用户允许 bot DM，自身 server 已把 bot 邀请进去。
3. 在 Desktop 或 `openclaw.json` 中保存 Discord token、owner user ID、server ID。
4. 启动 Gateway。
5. 用 owner Discord 账号给 bot 发送 `discord smoke ping`。
6. 执行：

```bash
openclaw pairing list discord
openclaw pairing approve --channel discord <CODE> --notify
openclaw channels list
openclaw agents bindings
```

7. 再发一条 `discord smoke after approve`。
8. 重启 Gateway。
9. 再发一条 `discord smoke after restart`。

通过标准：

- 第一条 DM 后能产生 pairing code，或在开放策略下直接回复。
- approve 后 DM 能正常回复，不出现 slash timeout、DM 被阻断、或“已连接但没回消息”。
- 重启 Gateway 后 DM 继续可用。

重点证据：

- pairing list 输出。
- channels list 中的 Discord 状态。
- DM 首次回复与重启后回复截图。

平台注意：

- 如果 owner 收不到第一条 pairing DM，优先检查 intents 和 Discord 侧 DM 开关，不要先归因到 Desktop UI。

### 6.4 微信

适用范围：Windows、macOS、Linux。

步骤：

1. 先确认宿主机 OpenClaw 版本：

```bash
openclaw --version
```

2. 若插件未安装，执行：

```bash
openclaw plugins install "@tencent-weixin/openclaw-weixin"
openclaw config set plugins.entries.openclaw-weixin.enabled true
```

3. 在 Desktop 发起微信连接，或执行：

```bash
openclaw channels login --channel openclaw-weixin
```

4. 用微信扫码完成登录。
5. 明确执行一次 Gateway 重启：

```bash
openclaw gateway restart
openclaw channels list
openclaw agents bindings
```

6. 从微信给 bot 发送 `wechat smoke ping`。
7. 确认收到回复后，再发送 `wechat smoke after restart` 前先重启 Gateway 一次。

通过标准：

- 登录链路能完成，且 plugin 不因 host version mismatch 拒载。
- Gateway 重启后 `channels list` 能看到 `openclaw-weixin` 处于健康状态。
- 第一条微信消息能正常得到回复。
- 再次重启 Gateway 后，不需要重新扫码就能继续回复。

重点证据：

- `openclaw --version` 输出。
- plugins install 或已安装状态证据。
- channels list 中的 `openclaw-weixin` 状态。
- 重启前后回复截图。

平台注意：

- CLI channel ID 一律是 `openclaw-weixin`，不是 `wechat`。
- 如果插件提示 host version 不兼容，优先升级 OpenClaw 或按插件说明切换到 legacy 线，不要继续做假通过记录。

## 7. 结果矩阵模板

### Tier-1 Channel Smoke Run YYYY-MM-DD HH:mm

- Desktop commit:
- OpenClaw version:
- Node version:
- 执行人:
- 网络环境:

| Channel | Windows | macOS | Linux | 备注 |
|---|---|---|---|---|
| Telegram | pass / fail / blocked | pass / fail / blocked | pass / fail / blocked | |
| WhatsApp | pass / fail / blocked | pass / fail / blocked | pass / fail / blocked | |
| Discord | pass / fail / blocked | pass / fail / blocked | pass / fail / blocked | |
| WeChat | pass / fail / blocked | pass / fail / blocked | pass / fail / blocked | |

补充记录：

- 失败项对应日志或截图路径：
- 是否需要上游 issue 链接：
- 是否阻塞发布：yes / no

## 8. 推荐准入标准

- 最低目标是 12 个格子全部 `pass`。
- 若出现 `blocked`，必须写清楚是账号、网络、上游回归、还是本地实现问题，不能直接忽略。
- 若同一通道在两个以上 OS 失败，默认按发布阻塞处理，直到拿到 workaround 或代码修复。
- 这份矩阵只覆盖 DM / 首次回复 / 重启保持，不覆盖 Discord voice、Telegram group、WhatsApp 群聊、微信多账号隔离等高级能力。