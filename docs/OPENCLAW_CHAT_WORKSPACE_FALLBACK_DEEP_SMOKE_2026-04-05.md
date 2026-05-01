# OCT-Agent Chat Workspace Fallback 深度手工脚本

最后更新：2026-04-05
适用范围：Desktop Chat 中 Project Folder 失效后的连续对话、降级提示、自愈清理、恢复文件编辑链路
关联修复：workspacePath 失效不再硬中断，改为普通聊天降级 + 前端自动清理失效目录

## 1. 目标

验证以下行为在真实桌面链路中稳定成立：

1. 已选 Project Folder 失效时，聊天不会中断或直接报错。
2. 普通问答会继续返回结果，并给出可操作提示。
3. 前端会自动清除本地缓存的失效项目目录，避免下条消息继续踩坑。
4. 文件编辑意图不会被伪成功；用户重新选择目录后可恢复项目文件编辑。
5. Gateway 路径与 CLI fallback 路径都能保持上述行为。

## 2. 执行前提

- Desktop 构建可通过：`cd packages/desktop && npm run build`
- 本机已安装 OpenClaw，且可执行：`openclaw gateway status`
- Desktop 聊天页面可正常打开
- 建议同时保留一个可写临时目录用于恢复验证

## 3. 测试数据准备

在系统临时目录创建两个测试路径：

- `valid-a`：初始可用目录
- `valid-b`：恢复时重新选择的目录

PowerShell 示例：

```powershell
$root = Join-Path $env:TEMP "ac-workspace-fallback-smoke"
$validA = Join-Path $root "valid-a"
$validB = Join-Path $root "valid-b"
$stale = Join-Path $root "stale-a"
New-Item -ItemType Directory -Force -Path $validA | Out-Null
New-Item -ItemType Directory -Force -Path $validB | Out-Null
New-Item -ItemType Directory -Force -Path $stale  | Out-Null
Write-Output "validA=$validA"
Write-Output "validB=$validB"
Write-Output "stale=$stale"
```

## 4. 场景脚本

### Case 01: 基线可用目录

步骤：

1. 在聊天页选择 `stale` 目录作为 Project Folder。
2. 发送：`请在当前项目目录创建 baseline.txt，内容是 BASELINE_OK`。

预期：

- 回复成功。
- `stale\\baseline.txt` 在磁盘上存在。
- 不出现 workspace fallback 提示。

### Case 02: 目录失效后普通问答不断流

步骤：

1. 在系统文件管理器或终端删除 `stale` 目录。
2. 回到同一聊天会话发送：`现在是普通问题：请用一句话总结今天的天气查询思路。`

预期：

- 聊天成功返回，不出现“Project folder could not be found”硬错误弹断。
- 回复附带“已切到普通聊天模式、如需改文件请重选目录”的提示文案。
- 输入框和会话状态保持可继续发送。

### Case 03: 连续多轮稳定性

步骤：

1. 在 Case 02 后连续发送两条普通消息：
   - `再给我三个执行建议。`
   - `把建议改成 checklist。`

预期：

- 两条都成功返回。
- 不再出现首条那种硬中断错误。
- 会话不应卡在 generating 或 no response。

### Case 04: 文件意图在降级模式下不伪成功

步骤：

1. 继续在未重选目录状态下发送：
   - `请在 src 下新建 smoke-note.txt，写入 hello`。

预期：

- 不应直接声称“已在失效目录写入成功”。
- 回复应引导先重新选择 Project Folder，再执行项目文件编辑。

### Case 05: 前端自愈清理（持久化）

步骤：

1. 触发 Case 02 后，关闭并重新打开 Desktop（或刷新前端）。
2. 回到聊天页观察 Project Folder 显示状态。

预期：

- 之前失效目录不会继续保留为选中状态。
- 不会每条消息都重复因为同一 stale path 触发硬失败。

### Case 06: 重新选择目录后恢复文件编辑

步骤：

1. 在聊天页重新选择 `valid-b`。
2. 发送：`请在当前项目目录创建 recovered.txt，内容是 RECOVER_OK`。

预期：

- 回复成功。
- `valid-b\\recovered.txt` 在磁盘上存在。
- 不再附加 workspace fallback 提示。

### Case 07: Gateway 不可用时 CLI fallback 仍不断流

步骤：

1. 先停止 Gateway：`openclaw gateway stop`。
2. 保持 Project Folder 为失效目录（可重复 Case 02 的方式）。
3. 发送普通消息：`请给我一个 3 步排查计划。`
4. 恢复 Gateway：`openclaw gateway start`。

预期：

- 即使走 CLI fallback，聊天仍返回文本结果。
- 不会出现“目录失效 + Gateway 不可用”双重条件下的直接中断。

### Case 08: 恢复后回归验证

步骤：

1. Gateway 已恢复后，在 `valid-b` 下发送：
   - `请列出当前项目目录文件并确认 recovered.txt 是否存在。`

预期：

- 能正常返回目录结果。
- recovered.txt 被识别为存在。

## 5. 结果记录模板

```md
### Workspace Fallback Smoke Run YYYY-MM-DD HH:mm

- OS:
- Desktop commit:
- OpenClaw version:
- 覆盖 Case: 01,02,03,04,05,06,07,08
- 通过:
- 失败:
- 风险:
- 结论: pass / fail / flaky
```

## 6. 判定标准

通过标准：

- Case 02/03/07 全部通过（代表“不会中断聊天”核心目标成立）
- Case 05/06 通过（代表“自动自愈 + 可恢复编辑”成立）

阻断标准：

- 任何一次目录失效后出现硬中断，导致用户无法继续发消息
- 声称已完成项目文件修改但磁盘无结果
- 重新选择有效目录后仍无法恢复项目文件编辑
