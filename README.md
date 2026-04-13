# AwarenessClaw

[![LongMemEval R@5](https://img.shields.io/badge/LongMemEval_R%405-95.6%25-brightgreen)](https://arxiv.org/abs/2410.10813)

> One-click AI agent with persistent memory. Built on [OpenClaw](https://openclaw.ai) + [Awareness Memory](https://awareness.market).

**AwarenessClaw** gives you a fully configured AI assistant that remembers everything across conversations — with zero technical setup. Powered by Awareness Memory, which achieves **95.6% Recall@5 on [LongMemEval](https://arxiv.org/abs/2410.10813)** (ICLR 2025) — the industry standard benchmark for long-term conversational memory.

## Features

- **One-Click Install**: Download, double-click, done. No terminal, no Node.js, no Git.
- **Persistent Memory**: Your AI remembers past conversations, decisions, and preferences. 95.6% recall accuracy on LongMemEval benchmark.
- **Visual Configuration**: Set up models, channels (Telegram, WhatsApp, Slack), and memory — all through a clean GUI.
- **Auto Upgrade**: Follows OpenClaw releases automatically.
- **Cross-Platform**: Windows, macOS, Linux.

## Benchmark: LongMemEval (ICLR 2025)

AwarenessClaw's memory system is evaluated on **[LongMemEval](https://arxiv.org/abs/2410.10813)** — the industry standard benchmark for long-term conversational memory.

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

## Quick Start

### Option 1: Desktop App (Recommended)

Download from [Releases](https://github.com/edwin-hao-ai/AwarenessClaw/releases):
- **Windows**: `AwarenessClaw-Setup.exe`
- **macOS**: `AwarenessClaw.dmg`
- **Linux**: `AwarenessClaw.AppImage`

### Option 2: CLI (Advanced)

```bash
npx @awareness-sdk/claw
```

## Architecture

```
AwarenessClaw (this project)
  └── wraps OpenClaw (open-source AI agent, 247K+ stars)
       └── pre-configured with Awareness Memory plugin
            └── hybrid search (vector + keyword)
            └── perception signals (contradiction, pattern, resonance)
            └── cross-device sync
```

## Development

```bash
# CLI
cd packages/cli && npm start

# Desktop
cd packages/desktop && npm run dev
```

## License

MIT
