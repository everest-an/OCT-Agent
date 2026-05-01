<p align="center">
      <img src="assets/github banner.png" alt="OCT AGENT" style="max-width: 100%; height: auto;" />
</p>

<p align="center">
  <a href="README.md">English</a>
  &nbsp;|&nbsp;
  <a href="#oct-agent-">中文</a>
</p>

<h1 align="center">OCT Agent 🐙</h1>

<p align="center">
  <a href="https://awareness.market"><img src="https://img.shields.io/badge/Documentation-Awareness-3B82F6?style=for-the-badge&logo=readthedocs&logoColor=white" alt="Documentation" /></a>
  <a href="https://discord.gg/awareness"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-22C55E?style=for-the-badge&logo=opensourceinitiative&logoColor=white" alt="Apache 2.0 License" /></a>
  <a href="https://awareness.market"><img src="https://img.shields.io/badge/Built%20by-Awareness-A855F7?style=for-the-badge&logo=sparkles&logoColor=white" alt="Built by Awareness" /></a>
</p>

> 一个不会忘记上下文、并且能像多条触手一样并行工作的 AI Agent。由 [Awareness](https://awareness.market) 构建。

**OCT** 来自 octopus。章鱼拥有出色的记忆能力，也能让多条触手并行行动。OCT Agent 对应的能力也是这样：跨对话记住信息，并协调多个 agent 同时处理复杂任务。

OCT 由 **Awareness Memory** 驱动，在长期对话记忆 benchmark [LongMemEval](https://arxiv.org/abs/2410.10813) 上达到 **95.6% Recall@5**。底层基于开源 AI Agent 框架 [OpenClaw](https://openclaw.ai)。

---

## 为什么是 OCT？

| 章鱼 | OCT Agent |
|---|---|
| 能长期记忆 | 跨会话持久记忆 |
| 8 条触手并行工作 | 多个 agent 同时协作 |
| 能适应不同环境 | 支持 Windows、macOS、Linux，以及 Telegram、WhatsApp、Slack 等渠道 |
| 没有单点瓶颈 | 每个 agent 都有自己的记忆和上下文 |

---

## OCT 有什么不同

| | OCT Agent | 其他 agent |
|---|---|---|
| **记忆** | LongMemEval Recall@5 95.6% | 没有持久记忆，或只做简单总结 |
| **多 agent** | 多 agent 并行协作，共享长期记忆池 | 通常只有单 agent |
| **安装** | 下载后双击安装，无需终端 | 经常需要 Node、Python、配置文件 |
| **渠道** | Telegram、WhatsApp、微信、Slack、Signal、Discord | 多数只支持 CLI |
| **Benchmark** | BM25 + Vector 混合检索，召回 0 LLM 调用 | 依赖 LLM 做召回 |

---

## 功能

- **🧠 持久记忆**：知识卡片、感知信号、跨会话召回。AI 会记住你是谁、做过什么决定、关心什么。
- **🐙 多 agent 协作**：为不同任务启动隔离 agent，并共享同一套长期记忆。
- **⚡ 一键安装**：下载、双击、完成。不需要终端、Node.js 或 Git。
- **📱 随时沟通**：连接 Telegram、WhatsApp、微信、Slack、Signal 或 Discord。
- **🔍 记忆 benchmark 领先**：LongMemEval Recall@5 95.6%，召回阶段 0 LLM 调用。
- **🌍 跨平台**：Windows、macOS、Linux。
- **🔄 自动升级**：跟随 OpenClaw release 自动升级。

---

## 记忆 Benchmark：LongMemEval (ICLR 2025)

OCT 的记忆由 **Awareness Memory** 驱动，并在长期对话记忆标准 benchmark [LongMemEval](https://arxiv.org/abs/2410.10813) 上评测。

```text
Awareness Memory — LongMemEval Benchmark Results

Recall@1    77.6%
Recall@3    91.8%
Recall@5    95.6%  PRIMARY
Recall@10   97.4%

Method:     Hybrid RRF (BM25 + Vector)
LLM Calls:  0
Hardware:   M1 8GB, 14 min
```

| System | R@5 | Note |
|---|---:|---|
| MemPalace (ChromaDB raw) | 96.6% | R@5 only |
| Awareness Memory (Hybrid) | 95.6% | Hybrid RRF |
| OMEGA | 95.4% | QA Accuracy |
| Supermemory | 81.6% | QA Accuracy |
| Zep / Graphiti | 71.2% | QA Accuracy |
| GPT-4o (full context) | 60.6% | QA Accuracy |

完整 benchmark 细节见英文 README 的 [Memory Benchmark](README.md#memory-benchmark-longmemeval-iclr-2025) 部分。

---

## 快速开始

### 方式 1：桌面端应用（推荐）

从 [awareness.market](https://awareness.market/) 或 [GitHub Releases](https://github.com/edwin-hao-ai/OCT-Agent/releases) 下载：

| 平台 | 下载 |
|---|---|
| **macOS** | `OCT-Agent.dmg` |
| **Windows** | `OCT-Agent.Setup.exe` |
| **Linux** | `OCT-Agent.AppImage` |

双击安装即可，无需终端。

### 方式 2：CLI（高级）

```bash
npx @awareness-sdk/claw
```

---

## 记忆如何工作

```text
你和 OCT 对话
      ↓
OCT 捕获知识卡片
  决策、偏好、事实、矛盾
      ↓
Awareness Memory 建立索引
  BM25 + Vector 混合检索，0 LLM 调用
      ↓
下一次对话前，OCT 先召回相关上下文
      ↓
你的 AI 随着每次会话变得更懂你
```

OCT 会追踪的记忆类型：

- **知识卡片**：事实、决策、偏好
- **感知信号**：矛盾、重复模式、强共鸣时刻
- **时间推理**：你在什么时候知道什么、观点如何变化
- **跨会话连续性**：从上次中断的位置继续

---

## 架构

```text
OCT Agent
  └── 封装 OpenClaw
       └── 预配置 Awareness Memory plugin
            └── BM25 + Vector 混合检索
            └── 感知信号：矛盾、模式、共鸣
            └── Awareness cloud 跨设备同步
```

---

## 开发

```bash
# CLI
cd packages/cli && npm start

# Desktop
cd packages/desktop && npm run dev
```

---

## License

Apache 2.0。由 [Awareness](https://awareness.market) 构建。
