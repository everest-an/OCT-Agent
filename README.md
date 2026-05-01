<p align="center">
  <img src="assets/github banner.png" alt="OCT-Agent" style="max-width: 100%; height: auto;" />
</p>

<p align="center">
  <a href="#english">English</a>
  &nbsp;|&nbsp;
  <a href="#中文">中文</a>
</p>

<p align="center">
  <a href="https://awareness.market"><img src="https://img.shields.io/badge/Documentation-Awareness-3B82F6?style=for-the-badge&logo=readthedocs&logoColor=white" alt="Documentation" /></a>
  <a href="https://discord.gg/awareness"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-22C55E?style=for-the-badge&logo=opensourceinitiative&logoColor=white" alt="Apache 2.0 License" /></a>
  <a href="https://awareness.market"><img src="https://img.shields.io/badge/Built%20by-Awareness-A855F7?style=for-the-badge&logo=sparkles&logoColor=white" alt="Built by Awareness" /></a>
</p>

<h1 id="english" align="center">OCT-Agent</h1>

<p align="center">
  The AI agent that remembers your context and coordinates parallel work.
</p>

OCT-Agent is a desktop and CLI AI agent built on [OpenClaw](https://openclaw.ai), with persistent long-term memory powered by Awareness Memory. It is named after the octopus: strong memory, many arms, and parallel action.

## Why OCT-Agent?

| What you need | What OCT-Agent does |
|---|---|
| Long-term memory | Remembers decisions, facts, preferences, and context across conversations |
| Parallel work | Runs multiple agents for separate workstreams |
| Easy setup | Desktop installer for Windows, macOS, and Linux |
| Multiple channels | Works with local chat and channel integrations such as Telegram, WhatsApp, Slack, WeChat, Signal, and Discord |
| Strong retrieval | Awareness Memory reaches 95.6% Recall@5 on LongMemEval with hybrid BM25 + vector search |

## Download

Download from [awareness.market](https://awareness.market/) or [GitHub Releases](https://github.com/edwin-hao-ai/OCT-Agent/releases).

| Platform | Release asset |
|---|---|
| Windows | `OCT-Agent.Setup.exe` |
| macOS | `OCT-Agent.dmg` |
| Linux | `OCT-Agent.AppImage` |

## CLI

```bash
npx @awareness-sdk/claw
```

The CLI package keeps a legacy `awareness-claw` command alias for compatibility, but `oct-agent` is the current brand-facing command.

## Memory

OCT-Agent uses Awareness Memory to build durable context from your conversations:

- Knowledge cards for facts, decisions, preferences, and project details
- Perception signals for contradictions, patterns, and important moments
- Hybrid retrieval with BM25 + vector search
- Zero LLM calls during recall
- Cross-session continuity so new conversations can start with relevant context

## Development

```bash
npm install
npm run build:desktop
npm run package:win
```

Desktop development:

```bash
cd packages/desktop
npm run dev
```

CLI development:

```bash
cd packages/cli
npm start
```

## License

Apache-2.0. Built by [Awareness](https://awareness.market).

---

<h1 id="中文" align="center">OCT-Agent</h1>

<p align="center">
  一个能记住上下文、并行协作的 AI Agent。
</p>

OCT-Agent 是基于 [OpenClaw](https://openclaw.ai) 构建的桌面端与 CLI AI Agent，并接入 Awareness Memory 长期记忆能力。OCT 的名字来自 octopus：强记忆、多触手、并行行动。

## 为什么选择 OCT-Agent？

| 需求 | OCT-Agent 的能力 |
|---|---|
| 长期记忆 | 跨会话记住决策、事实、偏好和项目上下文 |
| 并行工作 | 可启动多个 agent 处理不同工作流 |
| 易安装 | 支持 Windows、macOS、Linux 的桌面安装包 |
| 多渠道 | 支持本地聊天，以及 Telegram、WhatsApp、Slack、微信、Signal、Discord 等渠道集成 |
| 高质量召回 | Awareness Memory 在 LongMemEval 上达到 95.6% Recall@5，使用 BM25 + Vector 混合检索 |

## 下载

可从 [awareness.market](https://awareness.market/) 或 [GitHub Releases](https://github.com/edwin-hao-ai/OCT-Agent/releases) 下载。

| 平台 | Release 资产 |
|---|---|
| Windows | `OCT-Agent.Setup.exe` |
| macOS | `OCT-Agent.dmg` |
| Linux | `OCT-Agent.AppImage` |

## CLI

```bash
npx @awareness-sdk/claw
```

CLI 包会暂时保留旧的 `awareness-claw` 命令别名，用于兼容老用户；当前品牌主入口为 `oct-agent`。

## 记忆能力

OCT-Agent 使用 Awareness Memory 从对话中沉淀长期上下文：

- 用 knowledge cards 记录事实、决策、偏好和项目细节
- 用 perception signals 捕捉矛盾、模式和重要时刻
- 使用 BM25 + Vector 混合检索
- 召回阶段 0 LLM 调用
- 支持跨会话连续性，新对话也能带着相关上下文开始

## 开发

```bash
npm install
npm run build:desktop
npm run package:win
```

桌面端开发：

```bash
cd packages/desktop
npm run dev
```

CLI 开发：

```bash
cd packages/cli
npm start
```

## 许可证

Apache-2.0。由 [Awareness](https://awareness.market) 构建。
