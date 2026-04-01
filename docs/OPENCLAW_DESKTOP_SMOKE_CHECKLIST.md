# AwarenessClaw Desktop 手工冒烟清单

最后更新：2026-04-01
适用范围：`AwarenessClaw/packages/desktop/electron/main.ts` 及当前已拆出的主进程模块

## 1. 目的

这份清单用于限制高风险区继续拆分前的最低验证门槛。

用途不是覆盖所有功能，而是回答两个问题：

1. 这次重构后，Desktop 和本机 OpenClaw 的关键结合点还能不能工作。
2. 在没有补完这些手工验证之前，哪些区块不应该继续拆。

## 2. 执行前提

- 本机已安装 OpenClaw，且版本基线为 `OpenClaw 2026.3.31 (213a704)` 或更新兼容版本
- Desktop 当前 build 通过：`cd AwarenessClaw/packages/desktop && npm run build`
- 已知本地噪音允许存在：
  - `plugins.entries.signal` duplicate plugin override
  - `plugins.entries.qwen-portal-auth` stale config entry
- 若遇到新的 CLI 报错，先区分是否属于上述已知噪音

## 3. Startup / Lifecycle 冒烟

### 3.1 应用启动

- 启动 Desktop
- 预期：主窗口正常打开，无白屏，无启动即退出
- 预期：开发环境下前端可加载；打包构建后入口不报主进程错误

### 3.2 托盘与窗口行为

- 在 macOS 关闭窗口
- 预期：窗口隐藏而不是整个进程退出
- 再次从 dock 或 tray 打开
- 预期：窗口可恢复，无重复实例

### 3.3 二次启动

- 在 Desktop 已运行时再次启动应用
- 预期：不会产生第二个主实例；原窗口被唤起或聚焦

### 3.4 退出行为

- 正常退出应用
- 预期：不会留下明显的僵尸窗口；下次启动不因上次状态残留直接报错

## 4. Channel Setup 冒烟

这一组直接决定 `channel:setup` 后面能不能再继续细拆。

### 4.1 WeChat / URL QR 流

- 触发一个会输出 HTTPS 登录链接的 channel setup
- 预期：Desktop 能把非 localhost / 非 docs / 非 github 的 URL 识别为登录入口
- 预期：系统浏览器被正确打开
- 记录：实际 stdout 特征、Desktop 状态文案、是否成功连接

### 4.2 Signal / deep-link 流

- 触发一个会输出 `sgnl://...` 的 channel setup
- 预期：Desktop 调用系统协议打开 Signal deep-link
- 预期：不会误判成普通 URL 或 ASCII QR
- 记录：deep-link 是否被系统接管、失败时错误文案是什么

### 4.3 WhatsApp / ASCII QR 流

- 触发一个会输出 ASCII QR block 的 channel setup
- 预期：Desktop 通过 `channel:qr-art` 将完整 QR 块送到前端
- 预期：不会在 QR 尚未完整输出时提前截断
- 记录：是否成功显示、是否有超时或部分丢行

### 4.4 add-only 流

- 使用一个 `setupFlow=add-only` 的 channel
- 预期：执行 `openclaw channels add` 后直接成功，不进入 login 流
- 预期：成功后执行 bind 到 main agent

### 4.5 add-then-login 流

- 使用一个 `setupFlow=add-then-login` 的 channel
- 预期：先执行 `channels add`，再进入 login 流
- 预期：已存在账号时不会因 add 失败直接中断整个 setup

### 4.6 超时与失败路径

- 模拟 QR 超时或让 login 无法完成
- 预期：前端得到 `QR code expired. Click "Try again" to get a new QR code.`
- 模拟未进入 QR 阶段就超时
- 预期：前端得到 `Connection timed out. Make sure Gateway is running.`

## 5. Chat / Gateway 冒烟

这一组不做完，就不继续拆 `chat:*`。

### 5.1 Gateway 连接

- 打开 Desktop 聊天页并发送一条简单消息
- 预期：Gateway WebSocket 能建立连接
- 预期：若连接失败，能观察到 fallback 或明确错误，而不是静默失败

### 5.2 thinking / tool 状态流

- 发送一条会触发 reasoning 或 tool_use 的请求
- 预期：前端能依次看到 `thinking`、`tool_call`、`tool_update` 等状态
- 记录：事件顺序是否稳定，是否有丢失或重复

### 5.3 CLI fallback

- 在可控条件下让 WebSocket 失败
- 预期：代码能进入 CLI fallback，而不是直接终止
- 预期：仍能得到文本响应或明确错误

### 5.4 chat abort

- 在生成过程中点击 abort
- 预期：不会残留悬挂子进程
- 预期：前端状态能结束，不会一直停在 generating

## 6. 结果记录模板

每轮手工冒烟至少补一段结果，写入 `OPENCLAW_DESKTOP_COMPAT_AUDIT.md`：

```md
### Smoke Run YYYY-MM-DD HH:mm

- 环境：macOS / OpenClaw 版本
- 覆盖项：startup, channel setup, chat gateway
- 通过项：...
- 失败项：...
- 新发现风险：...
- 是否允许继续拆分：yes / no
```

## 7. 使用规则

- 这份清单没执行前，不把高风险区的 build 通过当成“可以继续拆”
- 任何一次高风险继续拆分前，至少先跑与该区块直接相关的最小子集
- 若实测能力不足，应停止拆分，而不是降低门槛