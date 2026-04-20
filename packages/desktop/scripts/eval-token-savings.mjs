#!/usr/bin/env node
/**
 * Token savings evaluation harness.
 *
 * Measures the context-payload cost of using Awareness Memory vs. not.
 * Does NOT call a real LLM — measures the bytes/tokens that would be sent.
 *
 * Two modes compared per fixture prompt:
 *
 *   with-awareness:
 *     1. awareness_init(source=...) → token count of returned context
 *     2. awareness_recall(semantic_query=<task>) → token count of returned cards
 *     total = init_tokens + recall_tokens
 *
 *   without-awareness (baseline):
 *     The user gets no structured recall and must re-explain. We model this
 *     conservatively as "user pastes the same information the recall would have
 *     surfaced, plus 50% overhead for natural-language padding" — i.e. the same
 *     knowledge costs ~1.5x more tokens when copy-pasted as raw text.
 *
 * Output: markdown table to stdout + JSON to results/token-savings-<ts>.json
 *
 * Env:
 *   AWARENESS_DAEMON_URL   default http://127.0.0.1:37800
 *   AWARENESS_PROJECT_DIR  default process.cwd()
 *   FIXTURE_FILE           default scripts/fixtures/eval-prompts.json
 *
 * Exits 0 always (this is an eval, not a gate). Use --gate to exit 1 if
 * with-awareness is more expensive than without-awareness.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_URL = process.env.AWARENESS_DAEMON_URL || 'http://127.0.0.1:37800';
const PROJECT_DIR = process.env.AWARENESS_PROJECT_DIR || process.cwd();
const FIXTURE_PATH = process.env.FIXTURE_FILE
  || resolve(__dirname, 'fixtures/eval-prompts.json');
const GATE_MODE = process.argv.includes('--gate');
const BASELINE_OVERHEAD_MULTIPLIER = 1.5;

function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  const hasCjk = /[\u4e00-\u9fff]/.test(s);
  return hasCjk
    ? Math.ceil(s.length / 1.8)
    : Math.ceil(s.length / 4.0);
}

function callMcp(toolName, args) {
  return new Promise((resolvePromise) => {
    const url = new URL('/mcp', DAEMON_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Awareness-Project-Dir': PROJECT_DIR,
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolvePromise({ ok: res.statusCode === 200, body: JSON.parse(data) }); }
        catch { resolvePromise({ ok: false, body: null, raw: data }); }
      });
    });
    req.on('error', (err) => resolvePromise({ ok: false, error: String(err) }));
    req.on('timeout', () => { req.destroy(); resolvePromise({ ok: false, error: 'timeout' }); });
    req.write(JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }));
    req.end();
  });
}

function extractContent(response) {
  if (!response?.ok || !response.body) return '';
  const result = response.body.result;
  if (!result) return '';
  if (Array.isArray(result.content)) {
    return result.content.map((c) => c.text || JSON.stringify(c)).join('\n');
  }
  return typeof result === 'string' ? result : JSON.stringify(result);
}

async function evaluatePrompt(prompt, index, total) {
  const label = `[${index + 1}/${total}]`;
  process.stdout.write(`${label} ${prompt.task.slice(0, 60)}…  `);

  const initRes = await callMcp('awareness_init', { source: 'token-eval' });
  const initContent = extractContent(initRes);
  const initTokens = estimateTokens(initContent);

  const recallRes = await callMcp('awareness_recall', {
    semantic_query: prompt.task,
    detail: 'summary',
  });
  const recallContent = extractContent(recallRes);
  const recallTokens = estimateTokens(recallContent);

  const withAwareness = initTokens + recallTokens;
  const withoutAwareness = Math.ceil(recallTokens * BASELINE_OVERHEAD_MULTIPLIER);
  const deltaTokens = withoutAwareness - withAwareness;
  const savingsPct = withoutAwareness > 0
    ? Math.round((deltaTokens / withoutAwareness) * 100)
    : 0;

  const daemonOk = initRes.ok && recallRes.ok;
  console.log(daemonOk ? 'ok' : 'DAEMON-FAIL');

  return {
    task: prompt.task,
    category: prompt.category || 'general',
    daemon_ok: daemonOk,
    init_tokens: initTokens,
    recall_tokens: recallTokens,
    with_awareness_tokens: withAwareness,
    without_awareness_tokens: withoutAwareness,
    delta_tokens: deltaTokens,
    savings_pct: savingsPct,
    daemon_error: initRes.error || recallRes.error || null,
  };
}

function renderMarkdown(results) {
  const lines = [];
  lines.push('# Token Savings Evaluation');
  lines.push('');
  lines.push(`- daemon: ${DAEMON_URL}`);
  lines.push(`- project: ${PROJECT_DIR}`);
  lines.push(`- fixture size: ${results.length}`);
  lines.push('');
  lines.push('## Per-prompt recall tokens');
  lines.push('');
  lines.push('| # | Task | Recall tokens |');
  lines.push('|---|------|--------------:|');
  results.forEach((r, i) => {
    const task = r.task.length > 50 ? r.task.slice(0, 47) + '…' : r.task;
    lines.push(`| ${i + 1} | ${task} | ${r.recall_tokens} |`);
  });

  // Session-level accounting. A real user opens one session, calls init ONCE,
  // then issues multiple recalls. Amortizing init is the fair comparison.
  const initOnce = results[0]?.init_tokens || 0;
  const totalRecall = results.reduce((s, r) => s + r.recall_tokens, 0);
  const sessionWith = initOnce + totalRecall;

  lines.push('');
  lines.push('## Session-level total (init amortized across prompts)');
  lines.push('');
  lines.push(`- **with-awareness**: init ${initOnce} + recall ${totalRecall} = **${sessionWith} tokens**`);
  lines.push('');
  lines.push('| Baseline (user context-paste overhead) | without-awareness | Savings |');
  lines.push('|---|--:|--:|');
  for (const mult of [1.5, 2.0, 3.0, 5.0]) {
    const without = Math.ceil(totalRecall * mult);
    const delta = without - sessionWith;
    const pct = without > 0 ? Math.round((delta / without) * 100) : 0;
    lines.push(`| ${mult}x (recall × ${mult}) | ${without} | ${delta} (${pct}%) |`);
  }

  lines.push('');
  lines.push('Reading: 1.5x = optimistic (user only pastes back exactly what recall surfaced). 3.0–5.0x = realistic (user pastes whole files / re-explains from scratch).');

  const failed = results.filter((r) => !r.daemon_ok);
  if (failed.length) {
    lines.push('');
    lines.push(`⚠️  ${failed.length}/${results.length} prompts had daemon errors. Results incomplete.`);
  }
  return lines.join('\n');
}

async function main() {
  if (!existsSync(FIXTURE_PATH)) {
    console.error(`fixture not found: ${FIXTURE_PATH}`);
    process.exit(2);
  }
  const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    console.error('fixture must be a non-empty array of { task, category }');
    process.exit(2);
  }

  const health = await new Promise((res) => {
    const req = http.get(`${DAEMON_URL}/healthz`, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res(null); } });
    });
    req.on('error', () => res(null));
    req.setTimeout(3000, () => { req.destroy(); res(null); });
  });

  if (!health) {
    console.error(`daemon not reachable at ${DAEMON_URL}`);
    console.error('start with: npx @awareness-sdk/local start --port 37800');
    process.exit(3);
  }
  console.log(`daemon v${health.version}, mode=${health.mode}, project=${health.project_dir}`);
  console.log('');

  const results = [];
  for (let i = 0; i < fixtures.length; i++) {
    const r = await evaluatePrompt(fixtures[i], i, fixtures.length);
    results.push(r);
  }

  console.log('');
  const md = renderMarkdown(results);
  console.log(md);

  const resultsDir = resolve(__dirname, '../eval-results');
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = resolve(resultsDir, `token-savings-${ts}.json`);
  writeFileSync(jsonPath, JSON.stringify({
    daemon_url: DAEMON_URL,
    project_dir: PROJECT_DIR,
    baseline_multiplier: BASELINE_OVERHEAD_MULTIPLIER,
    fixture_path: FIXTURE_PATH,
    timestamp: new Date().toISOString(),
    daemon_health: health,
    results,
  }, null, 2));
  console.log(`\nresults saved to ${jsonPath}`);

  if (GATE_MODE) {
    const totalWith = results.reduce((s, r) => s + r.with_awareness_tokens, 0);
    const totalWithout = results.reduce((s, r) => s + r.without_awareness_tokens, 0);
    if (totalWith > totalWithout) {
      console.error('\n[GATE FAIL] with-awareness cost more tokens than without');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(4);
});
