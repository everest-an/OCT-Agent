# OCT-Agent Windows 首聊自动恢复 Smoke 脚本

最后更新：2026-04-05
适用范围：Windows Desktop 首次安装后，daemon 仍在预热时的首聊恢复链路

## 1. 目标

验证以下两条用户可感知路径：

1. Setup 完成后，runtime 仍在预热时，启动闸门会做短暂复检，不会立即把用户丢进高失败概率窗口。
2. 即使首轮 CLI fallback 命中 `spawn npx ENOENT`，系统也会先静默修复本地 runtime，再自动重试一次请求。

## 2. 前置条件

- 操作系统：Windows 10/11
- Desktop 分支包含以下修复：
  - `packages/desktop/src/App.tsx` 的 post-setup daemon recheck
  - `packages/desktop/electron/ipc/register-chat-handlers.ts` 的 ENOENT 自愈重试
- 构建可通过：
  - `npm --prefix packages/desktop run build`

## 3. 执行步骤

### 3.1 基线准备

1. 启动 Desktop，完成 Setup 向导。
2. Setup 完成后不要等待太久（建议 30 秒内），直接进入聊天页。

### 3.2 首聊场景

1. 在聊天输入框发送一条简单消息，例如：
   - `hello`
2. 观察 UI 状态区与最终回复。

### 3.3 观测点

1. 若本地服务仍未完全就绪：
   - 允许短暂出现 warming 提示（例如 Local service is still warming up）。
2. 若 fallback 首轮命中 ENOENT：
   - 允许短暂出现自动恢复提示（例如 Local memory service is recovering. Retrying automatically...）。
3. 最终必须满足：
   - 同一轮用户请求拿到正常文本回复。
   - 不显示 Node 内部堆栈文本（例如 `at ChildProcess._handle.onexit`）。

## 4. 通过标准

全部满足才算通过：

1. 首聊请求最终返回成功回复。
2. 没有把 raw stack trace 暴露到聊天内容。
3. 不需要用户手工重新跑 Setup 才能完成首聊。

## 5. 失败记录模板

```md
### Windows First-Chat Recovery Smoke Run YYYY-MM-DD HH:mm

- 环境：Windows 版本 / Desktop 提交号 / OpenClaw 版本
- 步骤：Setup -> 首聊 immediate send
- 观察：warming 状态 / auto-retry 状态 / 最终回复
- 结果：pass / fail
- 失败细节：
- 日志片段：
- 结论：是否可发布
```

## 6. 排障建议

- 如果失败症状是 ENOENT 直接暴露给用户，优先检查：
  - `register-chat-handlers.ts` 中 `localRuntimeMissing` 分支是否仍在。
  - `prepareCliFallback` 是否成功注入到 chat handler deps。
- 如果失败症状是 Setup 后立刻进入聊天仍高概率失败，优先检查：
  - `App.tsx` 的 post-setup recheck 分支是否执行。
  - `app:startup-ensure-runtime` 是否返回 `blockingId: daemon-running` 时被提前放行。
