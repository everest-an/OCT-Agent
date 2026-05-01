<p align="center">
      <img src="assets/github banner.png" alt="OCT AGENT" style="max-width: 100%; height: auto;" />
</p>

# OCT Agent 🐙

[![Documentation](https://img.shields.io/badge/Documentation-Awareness-3B82F6?style=for-the-badge&logo=readthedocs&logoColor=white)](https://awareness.market)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/awareness)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-22C55E?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](LICENSE)
[![Built by Awareness](https://img.shields.io/badge/Built%20by-Awareness-A855F7?style=for-the-badge&logo=sparkles&logoColor=white)](https://awareness.market)

> The AI agent that never forgets — and works with all its arms at once. Built by [Awareness](https://awareness.market).

**OCT** is named after the octopus — a creature with extraordinary memory and eight arms that act in parallel. That's exactly what OCT does: it remembers everything across your conversations, and coordinates multiple agents working simultaneously on complex tasks.

Powered by **Awareness Memory**, which achieves **95.6% Recall@5 on [LongMemEval](https://arxiv.org/abs/2410.10813)** (ICLR 2025) — the industry benchmark for long-term conversational memory. Built on [OpenClaw](https://openclaw.ai) (247K+ stars), the open-source AI agent framework.

---

## Why OCT?

The octopus is nature's memory champion. Each arm has its own intelligence — they can act independently or in concert. OCT is built around the same idea:

| Octopus | OCT Agent |
|---------|-----------|
| Remembers across long periods | Persistent memory across all conversations |
| 8 arms working in parallel | Multiple agents collaborating simultaneously |
| Adapts to any environment | Runs on Windows, macOS, Linux — talk via Telegram, WhatsApp, Slack |
| No central bottleneck | Each agent has its own memory + context |

---

## What Makes OCT Different

| | OCT Agent | Other agents |
|---|---|---|
| **Memory** | 95.6% R@5 on LongMemEval (ICLR 2025) | No persistent memory, or basic summarization |
| **Multi-agent** | Parallel agents with shared memory pool | Single agent only |
| **Install** | One download, double-click — no terminal | Requires Node, Python, config files |
| **Channels** | Telegram, WhatsApp, WeChat, Slack, Signal, Discord | CLI only |
| **Benchmark** | Hybrid BM25+Vector, 0 LLM calls | LLM-dependent recall |

---

## Features

- **🧠 Persistent Memory** — Knowledge cards, perception signals (contradiction, pattern, resonance), and cross-session recall. Your AI remembers who you are, what you decided, and what you care about.
- **🐙 Multi-Agent Collaboration** — Spawn isolated agents for parallel workstreams. Each arm works independently; all arms share the same long-term memory.
- **⚡ One-Click Install** — Download, double-click, done. No terminal, no Node.js, no Git required.
- **📱 Talk from Anywhere** — Connect Telegram, WhatsApp, WeChat, Slack, Signal, or Discord. Your agent works while you're away.
- **🔍 Memory Benchmark Leader** — 95.6% Recall@5 on LongMemEval. Zero LLM calls. Hybrid BM25+Vector search.
- **🌍 Cross-Platform** — Windows, macOS, Linux. One binary, three platforms.
- **🔄 Auto Upgrade** — Follows OpenClaw releases automatically. No manual updates.

---

## Memory Benchmark: LongMemEval (ICLR 2025)

OCT's memory is powered by **Awareness Memory**, evaluated on the industry-standard [LongMemEval](https://arxiv.org/abs/2410.10813) benchmark.

```
╔══════════════════════════════════════════════════════════════╗
║   Awareness Memory — LongMemEval Benchmark Results           ║
║                                                              ║
║   Recall@1    77.6%       Recall@5    95.6%  ◀ PRIMARY       ║
║   Recall@3    91.8%       Recall@10   97.4%                  ║
║                                                              ║
║   Method:     Hybrid RRF (BM25 + Vector)                     ║
║   LLM Calls:  0       Hardware:  M1 8GB, 14 min             ║
╚══════════════════════════════════════════════════════════════╝
```

```
┌─────────────────────────────────────────────────────────────┐
│          Long-Term Memory Retrieval — R@5 Leaderboard       │
├─────────────────────────────────┬───────────┬───────────────┤
│  System                         │  R@5      │  Note         │
├─────────────────────────────────┼───────────┼───────────────┤
│  MemPalace (ChromaDB raw)       │  96.6%    │  R@5 only *   │
│  ★ Awareness Memory (Hybrid)    │  95.6%    │  Hybrid RRF   │
│  OMEGA                          │  95.4%    │  QA Accuracy  │
│  Supermemory                    │  81.6%    │  QA Accuracy  │
│  Zep / Graphiti                 │  71.2%    │  QA Accuracy  │
│  GPT-4o (full context)          │  60.6%    │  QA Accuracy  │
├─────────────────────────────────┴───────────┴───────────────┤
│  * MemPalace 96.6% is R@5 only, not QA Accuracy.           │
└─────────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────────┐
│     R@5 by Question Type                                    │
│                                                             │
│  knowledge-update        ████████████████████████████ 100%  │
│  multi-session           ███████████████████████████▋  98.5%│
│  single-session-asst     ███████████████████████████▌  98.2%│
│  temporal-reasoning      █████████████████████████▊    94.7%│
│  single-session-user     ████████████████████████▎     88.6%│
│  single-session-pref     ███████████████████████▏      86.7%│
│                                                             │
│  Overall                 █████████████████████████▉    95.6%│
└─────────────────────────────────────────────────────────────┘
```

Zero LLM calls. Hybrid BM25+Vector retrieval. [Full benchmark details →](https://github.com/edwin-hao-ai/Awareness/tree/main/benchmarks/longmemeval)

---

## Quick Start

### Option 1: Desktop App (Recommended)

Download from [awareness.market](https://awareness.market/) or [Releases](https://github.com/edwin-hao-ai/OCT-Agent/releases):

| Platform | Download |
|---|---|
| **macOS** | `OCT.dmg` |
| **Windows** | `OCT-Setup.exe` |
| **Linux** | `OCT.AppImage` |

Double-click to install. No terminal required.

### Option 2: CLI (Advanced)

```bash
npx @awareness-sdk/claw
```

---

## How Memory Works

Every conversation feeds OCT's memory loop:

```
You talk to OCT
      ↓
OCT captures knowledge cards
  (decisions, preferences, facts, contradictions)
      ↓
Awareness Memory indexes them
  (BM25 + Vector hybrid, 0 LLM calls)
      ↓
Next conversation: OCT recalls relevant context
  before you even ask
      ↓
Your AI gets smarter with every session
```

Memory types OCT tracks:
- **Knowledge cards** — facts, decisions, preferences you've stated
- **Perception signals** — contradictions, recurring patterns, strong resonance moments
- **Temporal reasoning** — what you knew when, how your views changed over time
- **Cross-session continuity** — picks up exactly where you left off

---

## Architecture

```
OCT Agent (this project)
  └── wraps OpenClaw (open-source AI agent, 247K+ stars)
       └── pre-configured with Awareness Memory plugin
            └── hybrid search (BM25 + Vector, Hybrid RRF)
            └── perception signals (contradiction, pattern, resonance)
            └── cross-device sync via Awareness cloud
```

---

## Development

```bash
# CLI
cd packages/cli && npm start

# Desktop
cd packages/desktop && npm run dev
```

---

## License

Apache 2.0 — Built by [Awareness](https://awareness.market).
