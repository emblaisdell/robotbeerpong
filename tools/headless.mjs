// Minimal headless browser harness over the Chrome DevTools Protocol, using
// Node 22's built-in fetch + WebSocket (no npm deps). Loads the game, collects
// console output + exceptions, waits for the match to run, and screenshots.
//
// Usage: node tools/headless.mjs <url> <out.png> [waitMs]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:8099/index.html?auto';
const out = process.argv[3] || '/tmp/rbp_shot.png';
const waitMs = parseInt(process.argv[4] || '11000', 10);
const PORT = 9333;

const chrome = spawn('/snap/bin/chromium', [
  '--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl',
  '--hide-scrollbars', '--window-size=1280,800', `--remote-debugging-port=${PORT}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('chromium devtools never came up');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  return { send, events };
}

(async () => {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const browser = cdp(ws);

  // New page target + attach.
  const { result: { targetId } } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => browser.send(m, p, sessionId);

  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[exception] ' + (d.exception?.description || d.text));
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(waitMs);

  const evalJs = async (expr) => {
    const { result } = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return result.result?.value;
  };
  const loaded = await evalJs('document.body.getAttribute("data-loaded")');
  const errors = await evalJs('(document.getElementById("errors")||{}).textContent || ""');
  const logText = await evalJs('(document.getElementById("log")||{}).innerText || ""');
  const cupsGoneA = await evalJs('document.querySelectorAll("#cupsA .pip.gone").length');
  const cupsGoneB = await evalJs('document.querySelectorAll("#cupsB .pip.gone").length');
  const banner = await evalJs('(document.getElementById("banner")||{}).textContent || ""');

  if (process.env.EVAL) {
    await send('Runtime.evaluate', { expression: process.env.EVAL });
    await sleep(500);
  }
  const { result: { data } } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(data, 'base64'));

  console.log('=== console/exceptions ===');
  console.log(logs.length ? logs.join('\n') : '(none)');
  console.log('\n=== page state ===');
  console.log('data-loaded:', loaded);
  console.log('errors div:', JSON.stringify(errors));
  console.log('cups sunk:  A=' + cupsGoneA, 'B=' + cupsGoneB);
  console.log('banner:', JSON.stringify(banner));
  console.log('\n=== play-by-play (log box) ===');
  console.log(logText || '(empty)');
  console.log('\nscreenshot ->', out);

  ws.close();
  chrome.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error(e); chrome.kill('SIGKILL'); process.exit(1); });
