# @awareness-sdk/claw

**AwarenessClaw CLI** — one-click setup for [OpenClaw](https://openclaw.ai) with persistent [Awareness](https://awareness.market) memory.

Installs OpenClaw, wires in the Awareness memory plugin, starts the local daemon, and walks you through model + channel configuration. Zero prior knowledge of Node, npm, or AI Agent tooling required.

## Quick Start

```bash
npx @awareness-sdk/claw
```

That's it. The interactive wizard will:

1. Detect (or install) Node.js and OpenClaw
2. Install the Awareness memory plugin
3. Start the local memory daemon on `http://localhost:37800`
4. Help you pick a model provider and enter an API key
5. Optionally bind messaging channels (Telegram, WhatsApp, WeChat, etc.)

### Non-interactive mode

```bash
npx @awareness-sdk/claw --api-key aw_xxx --memory-id <your-memory-id>
```

### Help

```bash
npx @awareness-sdk/claw --help
```

## What you get

- **OpenClaw** — open-source AI agent framework, running locally.
- **Awareness memory** — cross-session, cross-project persistent memory with knowledge cards, task tracking, and conflict detection.
- **One command to update everything** — run `npx @awareness-sdk/claw` again any time to reinstall / upgrade.

## Prefer a GUI?

Download the full **AwarenessClaw Desktop** app (Electron, macOS / Windows / Linux) from [awareness.market](https://awareness.market/) for a fully graphical experience.

## Requirements

- Node.js 18 or newer
- macOS / Linux / Windows
- Internet connection for the initial install

## License

Apache 2.0 — see [LICENSE](../../LICENSE) in the repository root.

## Links

- Website: <https://awareness.market/>
- Source: <https://github.com/edwin-hao-ai/AwarenessClaw>
- Memory cloud docs: <https://awareness.market/docs>
