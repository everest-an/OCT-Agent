import { GatewayClient } from '../dist-electron/gateway-ws.js';

const prompt = process.argv.slice(2).join(' ').trim()
  || 'Please think briefly, then use at least one tool to inspect the current environment and answer with one sentence.';

const sessionKey = `cx-deep-test-${Date.now()}`;
const client = new GatewayClient();
const events = [];

const finish = (timeout) => {
  console.log(JSON.stringify({ timeout, sessionKey, prompt, events }, null, 2));
  client.destroy();
  process.exit(0);
};

const timer = setTimeout(() => finish(true), 90000);

client.on('gateway-event', (evt) => {
  events.push({
    event: evt?.event || 'unknown',
    payload: evt?.payload || evt,
  });
});

client.on('event:chat', (payload) => {
  if (payload?.state === 'final' || payload?.state === 'error' || payload?.state === 'aborted') {
    clearTimeout(timer);
    finish(false);
  }
});

await client.connect();
await client.chatSend(sessionKey, prompt, { thinking: 'low' });