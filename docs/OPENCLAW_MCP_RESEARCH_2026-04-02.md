# OpenClaw MCP 调研与管理功能方案

日期：2026-04-02  
范围：AwarenessClaw Desktop、`@awareness-sdk/openclaw-memory`、OpenClaw 官方文档、Awareness MCP 服务端

## 一句话结论

OpenClaw 官方侧已经出现了 **MCP 相关基础设施与控制台入口**，因此不能再简单表述为“官方不支持 MCP”。但就当前公开文档与可验证配置模型看，它**还不像 Cursor / Claude Code / Windsurf 那样，以稳定、文档化的 `mcpServers` 配置面作为主要扩展入口**。它的原生扩展模型仍然是 `plugins` + `skills` + `tools`。  
但在我们这套集成里，OpenClaw **已经通过插件方式间接支持 MCP**：`openclaw-memory` 插件会把 Awareness 的能力注册成 OpenClaw 工具，并且在本地模式下直接调用本地 daemon 的 `/mcp` 接口。

所以如果我们要做“管理 MCP 的功能”，最合理的第一步不是做一个泛化的 OpenClaw MCP 平台，而是先做一个 **Awareness MCP 管理面板**：管理 daemon 健康、插件配置、工具可用性、调用诊断。  
如果目标是“任意第三方 MCP Server 都能接进 OpenClaw 并统一管理”，那不是纯 UI 功能，而是一个新的 **MCP Adapter Plugin / Runtime Capability**。

---

## 1. 这次调研回答的核心问题

### 1.1 OpenClaw 是否支持 MCP？

结论分两层看：

1. **作为通用宿主平台**：已能看到官方 MCP 相关基础设施迹象与控制台入口，但当前公开资料里还没有形成一个像 IDE 那样清晰稳定、文档化的 `mcpServers` 主配置模型。
2. **作为我们当前的集成结果**：支持，方式是 `openclaw-memory` 插件在 OpenClaw 内注册工具，再由插件去调用 Awareness MCP。

换句话说：

- OpenClaw 原生世界观是：`plugin -> registerTool/registerHook/registerChannel/...`
- 不是：`openclaw.json -> mcpServers -> 自动挂外部 MCP server`

这两个模型差异很大，后续产品设计必须基于这个事实。

### 1.2 OpenClaw 里的 MCP 现在是怎么“设置”的？

当前我们能确认的设置方式不是“在 OpenClaw 里填一个 MCP server 列表”，而是：

1. 安装 `@awareness-sdk/openclaw-memory` 插件。
2. 在 `~/.openclaw/openclaw.json` 里把它配置到 `plugins.entries.openclaw-memory.config`。
3. 可选地把 `plugins.slots.memory` 指向 `openclaw-memory`。
4. 插件运行时根据配置决定走云端 REST 还是本地 daemon。
5. 本地 daemon 模式下，插件直接调用 `http://127.0.0.1:37800/mcp`。

所以“OpenClaw 的 MCP 设置”在当前上下文里，本质上是 **插件配置 + daemon 连接配置**，不是 `mcpServers` 管理。

---

## 2. 证据链：源码和文档里到底有什么

## 2.1 OpenClaw 官方已经出现 MCP 迹象，但公开主配置仍以 plugin 模型为主

这次补充核对后，有几条新证据：

1. 本地 Control UI 存在 `http://127.0.0.1:18789/infrastructure` 页面入口。
2. OpenClaw 官方仓库最新提交列表里已经出现 `add MCP doctor ...` 之类的变更说明。
3. 官方插件 / SDK / Internals 文档持续在扩展能力注册、registry、runtime 这一层演进，这为 MCP bridge 提供了可落点的插件基础设施。

因此更准确的表述应该是：

> OpenClaw 官方**已经开始具备 MCP 基础设施能力**，但当前对外公开、稳定、文档化的主扩展模型仍然主要是 `plugins / skills / tools`，而不是 IDE 式直接配置 `mcpServers`。

从 OpenClaw 官方文档看，配置主轴是：

- `plugins`
- `skills`
- `tools`
- `gateway`
- `channels`
- `acp`

官方插件文档明确写的是在 `openclaw.json` 中配置：

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio"
        }
      }
    }
  }
}
```

对应资料：

- OpenClaw 插件文档说明扩展方式仍然以插件注册能力为主。
- 配置参考文档里有完整的 `plugins`、`skills`、`tools`、`acp` 章节；至少在当前公开文档中，还没有看到清晰稳定的 `openclaw.json -> mcpServers` 顶层配置契约。

这说明当前阶段更像是：

- IDE 生态：把 MCP 当“直接接外部工具的标准配置协议”
- OpenClaw：已经出现 MCP 基础设施，但主要还是把插件当“正式扩展机制”

## 2.2 OpenClaw 原生扩展机制是插件注册工具

OpenClaw 官方插件文档给出的宿主 API 是：

```ts
api.registerTool(...)
api.registerChannel(...)
api.registerProvider(...)
api.registerHook(...)
```

这说明 OpenClaw 期望扩展是通过插件 SDK 接进来，而不是直接把外部 MCP 服务器挂进配置表。

## 2.3 我们的 `openclaw-memory` 插件确实把 Awareness 能力注册成 OpenClaw 工具

在 `sdks/openclaw/src/memory-awareness.ts` 中，插件对象定义为：

- `id: "openclaw-memory"`
- `kind: "memory"`
- `register(api)` 中调用 `api.registerTool(...)`

它实际注册了这些工具：

- `awareness_recall`
- `awareness_lookup`
- `awareness_record`

同时，`sdks/openclaw/README.md` 也明确写了 OpenClaw 侧配置示例：

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-memory"
    },
    "entries": {
      "openclaw-memory": {
        "enabled": true,
        "config": {
          "apiKey": "aw_your-api-key",
          "baseUrl": "https://awareness.market/api/v1",
          "memoryId": "your-memory-id",
          "agentRole": "builder_agent",
          "autoRecall": true,
          "autoCapture": true,
          "recallLimit": 8
        }
      }
    }
  }
}
```

这已经足够说明：**当前 OpenClaw 的“Awareness MCP 接入”是插件配置驱动，不是 MCP server 注册驱动。**

## 2.4 本地模式下，插件会直接打本地 daemon 的 `/mcp`

`sdks/openclaw/src/client.ts` 的 `AwarenessClient` 有明确的本地模式逻辑：

- 当 `apiKey` 为空且 URL 指向 localhost 时，进入本地模式
- `localOrigin = baseUrl.replace(/\/api\/v1\/?$/, "")`
- `mcpCall()` / `mcpCallRaw()` 直接 `POST ${localOrigin}/mcp`

发送的是标准 JSON-RPC 风格请求：

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "method": "tools/call",
  "params": {
    "name": "awareness_recall",
    "arguments": { ... }
  }
}
```

这说明插件底层确实是在消费 MCP endpoint，只是这层细节被封装在插件里了。

## 2.5 AwarenessClaw Desktop 也已经在主进程里直接调用 daemon MCP

`AwarenessClaw/packages/desktop/electron/memory-client.ts` 里已经存在桌面端对本地 daemon 的直接调用：

- 固定地址：`http://127.0.0.1:37800/mcp`
- 方法：`tools/call`
- 超时：15s

`AwarenessClaw/packages/desktop/electron/ipc/register-memory-handlers.ts` 又把这些调用通过 IPC 暴露给前端页面，例如：

- `memory:search` -> `awareness_recall`
- `memory:get-cards` -> `awareness_lookup(type=knowledge)`
- `memory:get-tasks` -> `awareness_lookup(type=tasks)`
- `memory:get-context` -> `awareness_init`

这意味着：

1. Desktop 当前已经有一套可工作的 MCP client 能力。
2. 如果做管理面板，可以优先复用现有主进程调用链，而不是重新设计协议层。

## 2.6 Desktop 当前能管理的是 OpenClaw 插件，而不是 MCP server 列表

`AwarenessClaw/packages/desktop/electron/ipc/register-openclaw-config-handlers.ts` 目前支持：

- `plugins:list`
- `plugins:toggle`
- `hooks:list`
- `hooks:toggle`
- `openclaw-config:read`
- `openclaw-config:write`
- `openclaw-config:schema`

它操作的是 `~/.openclaw/openclaw.json`，而且插件状态就是 `config.plugins.entries.<name>`。

前端 `AwarenessClaw/packages/desktop/src/pages/Settings.tsx` 也已经在设置页里消费：

- `pluginsList()`
- `pluginsToggle()`
- `hooksList()`
- `hooksToggle()`

UI 上已有一个成熟的 Plugins section。也就是说，**我们已经有“管理 OpenClaw 扩展”的 UI 落点，但还没有“管理 MCP server”的抽象。**

---

## 3. 容易混淆的三个概念

## 3.1 OpenClaw Plugin

这是 OpenClaw 原生扩展机制。插件可以注册：

- tool
- channel
- provider
- hook
- service

这是 OpenClaw 官方推荐路径。

## 3.2 Awareness MCP

这是 Awareness 服务暴露的协议接口，至少包含：

- `/mcp`
- `awareness_init`
- `awareness_recall`
- `awareness_lookup`
- `awareness_record`

它既能服务 IDE，也能被本地 daemon / 插件消费。

## 3.3 OpenClaw ACP

OpenClaw 文档里还有一个 `acp` 配置块。这个是 OpenClaw 自己的 Agent Control / runtime 体系，不是 MCP。  
如果后面做产品方案时把 ACP 当成 MCP，会直接把架构判断带偏。

---

## 4. “OpenClaw 支持 MCP”应该怎么准确表述

更准确的说法是：

### 4.1 可以说“支持”的部分

OpenClaw **可以通过插件接入一个底层基于 MCP 的能力源**。  
在我们当前项目中，这个能力源就是 Awareness daemon / Awareness backend。

### 4.2 不能直接说“原生通用支持”的部分

截至当前可核对的公开文档，还没有看到 OpenClaw 官方把下面这种模型作为稳定主入口文档化：

```json
{
  "mcpServers": {
    "foo": { ... },
    "bar": { ... }
  }
}
```

也没有证据表明它会像 IDE 那样自动发现多个外部 MCP server、统一列工具、统一调度。

### 4.3 最准确的产品定义

当前更适合定义为：

> OpenClaw 目前通过插件体系支持接入 MCP-backed capability，但不等于已经有通用 MCP server 管理平台。

---

## 5. 当前“设置 MCP”的真实落点

如果我们只看现有的 Awareness 集成，那么 MCP 相关设置分成三层：

## 5.1 OpenClaw 配置层

文件：`~/.openclaw/openclaw.json`

关键字段：

- `plugins.slots.memory`
- `plugins.entries.openclaw-memory.enabled`
- `plugins.entries.openclaw-memory.config.apiKey`
- `plugins.entries.openclaw-memory.config.baseUrl`
- `plugins.entries.openclaw-memory.config.memoryId`
- `plugins.entries.openclaw-memory.config.agentRole`
- `plugins.entries.openclaw-memory.config.autoRecall`
- `plugins.entries.openclaw-memory.config.autoCapture`
- `plugins.entries.openclaw-memory.config.recallLimit`
- `plugins.entries.openclaw-memory.config.localUrl`（源码支持本地模式）

## 5.2 Desktop 主进程调用层

文件：

- `AwarenessClaw/packages/desktop/electron/memory-client.ts`
- `AwarenessClaw/packages/desktop/electron/ipc/register-memory-handlers.ts`

负责：

- 发 JSON-RPC 到 `127.0.0.1:37800/mcp`
- 做 daemon 健康检查
- 拉取 memory REST 数据
- 给前端页面暴露 IPC

## 5.3 Awareness 后端 / daemon 层

后端本身提供：

- MCP URL 计算逻辑
- IDE MCP 配置模板
- `mcpServers` JSON 示例生成

这里的 `mcpServers` 是给 IDE 和 wizard 产物用的，不是 OpenClaw 主配置原生的一部分。

`backend/mcp_tools/server_utils.py` 里的 `_MCP_CONFIG_TEMPLATE` 直接说明了这一点：它生成的是标准 IDE 风格的：

```json
{
  "mcpServers": {
    "awareness": {
      "url": "<MCP_URL>",
      "headers": {
        "Authorization": "Bearer <API_KEY>",
        "X-Awareness-Memory-Id": "<MEMORY_ID>"
      }
    }
  }
}
```

这属于 Awareness 平台对外的接入模板，不是 OpenClaw 宿主的原生配置项。

---

## 6. 如果我们做“管理 MCP”的功能，应该怎么做

先给结论：**建议分两期。**

## 6.1 第一阶段：做 “Awareness MCP 管理面板”

这是当前最稳、最贴业务、最少误判的一步。

### 目标

让用户在 Desktop 里可视化管理当前这条链路：

`OpenClaw 插件配置 -> 本地 daemon -> Awareness MCP 工具`

### 推荐落点

基于现有 Settings 页扩展，而不是新建独立架构：

- 现有页：`AwarenessClaw/packages/desktop/src/pages/Settings.tsx`
- 现有区块：Plugins、Health、Gateway、Workspace、Security
- 推荐新增：`Awareness MCP` section 或 `Memory / MCP` section

### 第一阶段应该展示什么

1. **Daemon 状态**
   - 是否在线
   - `/healthz` 响应
   - 端口 / URL
   - 最近错误

2. **Plugin 配置状态**
   - `openclaw-memory` 是否安装
   - 是否启用
   - `plugins.slots.memory` 当前指向
   - `localUrl / baseUrl / memoryId / agentRole / autoRecall / autoCapture / recallLimit`

3. **MCP 工具探活**
   - `awareness_init`
   - `awareness_recall`
   - `awareness_lookup`
   - `awareness_record`

4. **调用诊断**
   - 最近 N 次调用是否成功
   - 错误类型（超时 / 连接失败 / JSON 解析失败 / tool error）
   - 最后一次成功时间

5. **操作按钮**
   - 检查健康状态
   - 测试连接
   - 打开插件配置
   - 重启 daemon
   - 刷新 OpenClaw plugin 状态

### 第一阶段最适合复用的代码

可直接复用：

- `memory-client.ts` 的 `callMcp` / `checkMemoryHealth`
- `register-memory-handlers.ts` 的现有 IPC 入口
- `register-openclaw-config-handlers.ts` 的配置读写能力
- `Settings.tsx` 已有的插件 / 健康页模式

### 第一阶段需要新增的能力

建议新增 IPC：

- `mcp:probe-tools`
- `mcp:get-config`
- `mcp:save-config`
- `mcp:test-tool`
- `mcp:get-diagnostics`

这些都可以放在主进程，不需要先动 OpenClaw 宿主本身。

## 6.2 第二阶段：如果要支持“通用第三方 MCP 管理”

这已经不是简单 UI 增强，而是一个新平台能力。

### 为什么它不是纯前端功能

因为 OpenClaw 当前原生抽象是 plugin，不是 MCP server registry。  
如果想让用户在 UI 里添加一个任意 MCP server，然后直接让 OpenClaw 可调用它的工具，至少要补下面这些东西：

1. **MCP Adapter Plugin**
   - 负责连接外部 MCP server
   - 发现工具列表
   - 把外部工具映射成 OpenClaw 可注册工具

2. **配置模型**
   - 保存 server 列表
   - transport 类型：stdio / HTTP / SSE / streamable-http
   - headers / env / auth / timeout
   - tool allow/deny
   - 命名空间策略

3. **运行时治理**
   - 连接重试
   - tool schema 缓存
   - tool name collision 处理
   - 可观测性 / 日志 / 熔断
   - 权限与风险分级

4. **OpenClaw 侧工具映射策略**
   - `serverA.read_file` 怎么映射
   - 是否前缀命名
   - 是否支持动态刷新
   - 是否支持 per-agent 可见性

### 第二阶段建议的最小架构

建议不是直接修改 OpenClaw 核心，而是先做一个独立插件，例如：

- `@awareness-sdk/openclaw-mcp-bridge`

这个插件负责：

1. 读取 `plugins.entries.openclaw-mcp-bridge.config.servers`
2. 连接多个 MCP server
3. 拉取工具描述
4. 动态注册为 OpenClaw tool
5. 给 Desktop 暴露可管理状态

这样可以把风险控制在插件边界内。

### 第二阶段推荐的配置模型示意

```json
{
  "plugins": {
    "entries": {
      "openclaw-mcp-bridge": {
        "enabled": true,
        "config": {
          "servers": [
            {
              "id": "awareness-local",
              "transport": "http",
              "url": "http://127.0.0.1:37800/mcp",
              "enabled": true,
              "toolPrefix": "awareness"
            }
          ]
        }
      }
    }
  }
}
```

这一步才配得上“OpenClaw MCP 管理功能”这个命名。

---

## 7. 产品建议：现在应该做哪一种

在上一版结论里，我把近期建议偏向了 `Awareness MCP 管理面板`。  
但如果把目标改成“这是给普通用户用的产品，用户需要消费越来越多第三方能力”，那还必须补一句：

> **长期来看，通用 MCP 接入不是锦上添花，而是能力生态层。**

也就是说，前面的判断并没有变：

- OpenClaw 目前没有现成的通用 `mcpServers` 宿主
- 不能靠简单 UI 就让任意 MCP server 自动可用

但产品方向要调整为：

- **短期**：先把 Awareness 这条链路做稳，形成可配置、可诊断、可复制的管理体验
- **中期**：把“外部 MCP server -> OpenClaw tool”这层桥接做出来
- **长期**：把 MCP 生态变成用户可安装、可启用、可审计的能力市场

这才符合“面向用户扩展能力边界”的产品目标。

## 7.1 推荐优先级

### P1：Awareness MCP 管理面板

适合立即做，原因：

- 已有真实用户价值
- 已有 Desktop 调用链
- 已有 Settings/Plugins UI 容器
- 不需要发明 OpenClaw 新平台能力
- 风险低

### P2：MCP 调试控制台

在 P1 之上增加一个开发者模式能力：

- 手工发送 tool call
- 查看原始 JSON-RPC 请求 / 响应
- 查看 tool schema
- 导出诊断日志

这对排查 daemon / plugin / config 问题会很有价值。

### P3：通用第三方 MCP Bridge

只有在明确有“接多种第三方 MCP server”的业务需求后再做。  
否则很容易做成一个维护成本高、边界复杂、实际使用率低的系统。

如果按“给用户更多东西的能力”来判断，这里的优先级需要上调。  
不是因为技术上更简单，而是因为它决定产品最终是不是一个封闭能力集合，还是一个开放能力平台。

### 面向用户产品的重新排序

如果产品目标明确是“让用户消费更多外部服务能力”，更合理的路线其实是：

1. `P1a`：Awareness MCP 管理面板，先把我们自己的链路做成样板
2. `P1b`：MCP Bridge 最小可用版，先支持少量高价值第三方 MCP server
3. `P2`：开发者 / 高级用户调试控制台
4. `P3`：能力市场化、审核、推荐、权限模板

也就是说，**通用 MCP Bridge 不一定要等很久，但它应该以“桥接插件/运行时”形式落地，而不是先从 UI 开始。**

## 7.2 为什么通用 MCP 对用户产品是必要的

像企查查这类服务，如果它对外主要以 MCP server 形式提供能力，那么用户要想在 OpenClaw 里直接使用它，本质上只剩两条路：

1. 我们自己重新写一遍官方插件或 API 集成
2. 我们支持消费它现成的 MCP server

第一条路的问题很明显：

- 每接一个服务就要单独开发和维护
- 会被第三方生态更新频率牵着走
- 很多长尾服务根本没有投入产出比
- 我们会被迫变成“能力搬运工”

第二条路才更像平台策略：

- 谁提供 MCP server，我们就有机会接入
- 我们只需要做好桥接、权限、诊断、审核
- 平台能力边界随 MCP 生态自然扩展

所以从产品战略上说：

> **MCP 对用户产品的意义，不是多一个协议，而是把“服务接入成本”从“每个服务做一次工程集成”降成“做一层统一桥接”。**

## 7.3 这件事在 OpenClaw 上技术上是否可行

从 OpenClaw 官方 SDK 文档看，这条路是可行的，因为插件 API 至少提供了：

- `api.registerTool(...)`
- `api.registerHttpRoute(...)`
- `api.registerGatewayMethod(...)`
- `api.registerService(...)`

这意味着理论上可以做一个 `openclaw-mcp-bridge` 插件，让它负责：

1. 维护外部 MCP server 连接
2. 拉取工具 schema
3. 将外部能力注册为 OpenClaw 工具
4. 提供后台保活、缓存、重试和诊断

所以结论不是“OpenClaw 不能做通用 MCP”，而是：

> **OpenClaw 现在没有现成通用 MCP 宿主，但它的插件 SDK 足够支撑我们补出这层能力。**

## 7.4 面向用户的推荐产品形态

如果以最终用户为核心，而不是只面向开发者，我更建议把功能定义成：

### 形态 A：Capabilities

不要直接暴露“你在配置一个 MCP server”，而是暴露“你在安装一个能力”。

例如用户看到的是：

- 企业信息查询
- 地图与路线
- 文档翻译
- 财报查询
- CRM 查询

底层再把这些能力映射到：

- 原生 OpenClaw plugin
- MCP Bridge plugin 里的某个 MCP server
- 我们自建的服务连接器

这样对用户更自然。

### 形态 B：双层模型

给产品保留两层：

1. **用户层**：安装能力、开关权限、配置账号、看最近调用
2. **高级层**：查看这是原生 plugin 还是 MCP bridge、server URL、transport、headers、日志

这能同时满足普通用户和高级用户。

### 形态 C：审核和权限模板

如果将来真的支持很多第三方 MCP server，必须在产品层增加：

- 能力来源标识
- 风险等级
- 默认权限模板
- 用户授权确认
- 调用审计

否则“能接很多能力”会立刻变成“安全边界失控”。

---

## 8. 我建议的实施路径

## Phase 1：不动 OpenClaw 核心，只增强 Desktop

目标：把当前 Awareness 集成做成可诊断、可配置、可测试。

建议任务拆分：

1. 在 Settings 中新增 `Awareness MCP` 区块
2. 展示 daemon 健康与插件配置
3. 增加 `测试 MCP` 按钮
4. 增加工具探测与错误展示
5. 支持直接编辑 `openclaw-memory` 的关键配置

## Phase 2：增加开发者调试能力

建议任务拆分：

1. Tool list
2. Raw request / response
3. 最近调用日志
4. 一键复制诊断信息

## Phase 3：评估是否需要 bridge 插件

进入条件：

- 明确需要接多个非 Awareness MCP server
- 明确要在 OpenClaw 内统一调度
- 明确能接受额外的安全治理与运行时复杂度

---

## 9. 这次调研最重要的判断

### 判断 1

OpenClaw 当前不是“IDE 式通用 MCP 管理器”，而是“插件式宿主平台”。

### 判断 2

我们现在已经有一条可工作的 MCP 链路，但它是：

`OpenClaw plugin -> Awareness client -> local daemon / cloud backend MCP`

不是：

`OpenClaw host -> generic mcpServers registry -> external MCP tools`

### 判断 3

因此现在最对路的产品动作是：

**先做 Awareness MCP 管理面板，不要一上来做泛化的 OpenClaw MCP 管理中心。**

---

## 10. 关键参考文件

### Desktop / UI / IPC

- `AwarenessClaw/packages/desktop/src/pages/Settings.tsx`
- `AwarenessClaw/packages/desktop/src/components/settings/SettingsOperationsPanels.tsx`
- `AwarenessClaw/packages/desktop/electron/memory-client.ts`
- `AwarenessClaw/packages/desktop/electron/ipc/register-memory-handlers.ts`
- `AwarenessClaw/packages/desktop/electron/ipc/register-openclaw-config-handlers.ts`

### OpenClaw plugin integration

- `sdks/openclaw/README.md`
- `sdks/openclaw/src/memory-awareness.ts`
- `sdks/openclaw/src/client.ts`

### Awareness MCP / wizard / config generation

- `backend/mcp_tools/server_utils.py`
- `backend/awareness/core/runtime_settings.py`
- `backend/awareness/api/services/memory_wizard_plan.py`
- `backend/awareness-spec.json`

### 官方文档（调研参考）

- OpenClaw Configuration
- OpenClaw Configuration Reference
- OpenClaw Plugins
- OpenClaw Tools and Plugins
