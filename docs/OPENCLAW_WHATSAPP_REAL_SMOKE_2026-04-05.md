# OCT-Agent WhatsApp 真机手工冒烟脚本

最后更新：2026-04-05
适用范围：Desktop Channels 一键连接、WhatsApp DM 策略、配对审批、重连稳定性

## 1. 目标

这份脚本用于验证真实 WhatsApp 设备链路（不是 mock，不是纯 CLI dry-run）：

1. 默认防打扰是否生效：陌生联系人不会收到内部配对提示或错误提示。
2. owner 自聊是否可用：已绑定号码可正常对话。
3. allowlist 与 pairing 路径是否可控：需要放行时能精确放行，不影响其它联系人。
4. 重启和重连后策略是否保持一致。

## 2. 时间预算

1. 总时长：20-30 分钟。
2. 环境准备：5 分钟。
3. 核心链路验证：15-20 分钟。
4. 结果记录：5 分钟。

## 3. 测试矩阵（必须是真实账号）

1. A 号：当前被扫码绑定到 OpenClaw 的 WhatsApp 账号（owner）。
2. B 号：普通联系人（默认不在 allowFrom 中）。
3. C 号：可选，作为显式 allowlist 联系人；若无 C，可用 B 复用。

建议：测试前先在群里告知联系人，避免误会。

## 4. 执行前检查（Windows PowerShell / macOS & Linux Bash）

在 Desktop 所在机器执行。

### Windows (PowerShell)

```powershell
openclaw --version
openclaw gateway status
openclaw channels list

# 仅用于检查是否还残留历史非法字段
if (Test-Path "$HOME\.openclaw\openclaw.json") {
  Select-String -Path "$HOME\.openclaw\openclaw.json" -Pattern '"errorPolicy"' -SimpleMatch | ForEach-Object { $_.Line }
}
```

### macOS / Linux (Bash/Zsh)

```bash
openclaw --version
openclaw gateway status
openclaw channels list

# 仅用于检查是否还残留历史非法字段
CONFIG_PATH="$HOME/.openclaw/openclaw.json"
if [ -f "$CONFIG_PATH" ]; then
  grep -n '"errorPolicy"' "$CONFIG_PATH" || true
fi
```

通过标准：

1. Gateway 状态正常（running/ok）。
2. WhatsApp 通道已配置并可见。
3. 配置中不应再出现 `channels.whatsapp.errorPolicy`。

## 5. 核心场景

### Case A：默认防打扰（高优先）

步骤：

1. 在 Desktop Channels 页面完成 WhatsApp 一键连接（若已连接可直接继续）。
2. 确认当前 `channels.whatsapp.dmPolicy` 为 `allowlist`（或按产品预期值）。
3. 用 B 号给 bot 发一条普通私聊消息（例如：hello smoke）。

预期：

1. B 号不应收到 pairing code。
2. B 号不应收到“access not configured”这类内部错误提示。
3. 系统不应向 B 号回任何噪音文本。

失败判定：

1. B 号收到了配对码或内部错误提示。
2. B 号收到了非预期自动回复（且未被 allowlist/approved）。

### Case B：owner 自聊可用

步骤：

1. A 号（owner）给 bot 发一条消息：`self smoke ping`。
2. 连续发送第二条：`请回复 SELF_OK`。

预期：

1. owner 对话可正常返回。
2. 不出现 pairing 提示。

### Case C：显式 allowlist 放行

步骤：

1. 将 B（或 C）号加入 `channels.whatsapp.allowFrom`。
2. 保存配置并等待生效（通常热更新即可，必要时重启 Gateway）。
3. 让该联系人发送：`allowlist smoke ping`。

预期：

1. 联系人能正常收到回复。
2. 不触发 pairing 提示。

### Case D：受控 pairing 流程（可选，但建议）

说明：此场景用于验证 pairing 功能本身，不是默认防打扰策略。

步骤：

1. 临时把 `dmPolicy` 调整为 `pairing`。
2. 用一个未放行联系人发送消息。
3. 在 Desktop（Channels 配对审批面板）或 CLI 批准：

```powershell
openclaw pairing list whatsapp
openclaw pairing approve --channel whatsapp <CODE> --notify
```

4. 让该联系人再次发送消息。

预期：

1. pairing code 为 8 位大写字符。
2. 配对审批后该联系人可正常对话。
3. 配对码过期规则与官方一致（约 1 小时），pending 上限不超过 3。

### Case E：重启一致性

步骤：

1. 执行 `openclaw gateway restart`。
2. 关闭并重新打开 Desktop。
3. 重复 Case A 与 Case B 的最小动作各一次。

预期：

1. 策略不漂移。
2. 防打扰与 owner 可用性仍成立。

### Case F：断开重连回归

步骤：

1. 在 Desktop 断开 WhatsApp 通道。
2. 立即重新连接。
3. 重跑 Case A 一次。

预期：

1. 重连后仍保持默认防打扰行为。
2. 不出现“连接成功但给陌生联系人发内部提示”的回归。

## 6. 快捷诊断命令（跨平台）

```powershell
openclaw channels status --probe
openclaw channels list
openclaw pairing list whatsapp
openclaw logs --follow
```

## 7. 结果记录模板

```md
### WhatsApp Real Smoke Run YYYY-MM-DD HH:mm

- OS:
- Desktop commit:
- OpenClaw version:
- 测试账号: A(owner), B(stranger), C(allowlist 可选)
- Case A 默认防打扰: pass/fail
- Case B owner 自聊: pass/fail
- Case C allowlist 放行: pass/fail
- Case D pairing 流程: pass/fail/skip
- Case E 重启一致性: pass/fail
- Case F 断开重连: pass/fail
- 证据: 截图/录屏/日志片段
- 结论: pass / fail / flaky
```

## 8. 回滚与清理

测试后请恢复预期策略（建议默认防打扰策略），并清理临时联系人配置：

1. 还原 `dmPolicy` 到产品默认值。
2. 清理测试期间临时加入的 `allowFrom`。
3. 重启 Gateway 并回归一条 owner 消息确认可用。
