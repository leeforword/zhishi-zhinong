/**
 * shot-final.mjs — 生成交付说明用的截图
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(ROOT, 'screenshots');
const PORT = 8970;
const CDP = 9330;

const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, ['server.mjs', String(PORT), '--lan'], {
  cwd: path.join(ROOT, 'web'), stdio: 'ignore'
});
await sleep(1500);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=' + CDP,
  '--user-data-dir=' + path.join(process.env.TEMP || '.', 'sf' + Date.now()),
  'about:blank'
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
      const l = await r.json();
      const p = l.find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  throw new Error('cdp');
}
function send(m, p) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  return new Promise(r => pending.set(i, r));
}
async function ev(x) {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return null;
  return r.result ? r.result.value : undefined;
}

ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await send('Runtime.enable');
await send('Page.enable');

/* ---- 1. 扫码页（桌面尺寸） ---- */
console.log('== 扫码页 ==');
await send('Emulation.setDeviceMetricsOverride', {
  width: 900, height: 780, deviceScaleFactor: 2, mobile: false
});
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/qr` });
await sleep(1500);
let shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(SHOTS, '11-qr-page.png'), Buffer.from(shot.data, 'base64'));
console.log('  SHOT 11-qr-page.png');

/* ---- 2. 手机端完整页 ---- */
console.log('\n== 手机端 ==');
const devices = [
  { file: '12-mobile-iphone.png', w: 390, h: 844, name: 'iPhone 14' },
  { file: '13-mobile-android.png', w: 360, h: 800, name: 'Android' }
];

for (const d of devices) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: d.w, height: d.h, deviceScaleFactor: 2, mobile: true,
    screenWidth: d.w, screenHeight: d.h
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(5500);

  // 等数据
  for (let i = 0; i < 30; i++) {
    const st = await ev("document.getElementById('statusText').textContent");
    if (st && String(st).indexOf('实时数据') >= 0) break;
    await sleep(400);
  }
  await sleep(1000);

  // 首屏
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, d.file), Buffer.from(shot.data, 'base64'));
  console.log('  SHOT ' + d.file + '  (' + d.name + ' 首屏)');

  // 抽屉打开
  await ev("document.getElementById('menuBtn').click();");
  await sleep(600);
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, '14-mobile-drawer.png'), Buffer.from(shot.data, 'base64'));
  console.log('  SHOT 14-mobile-drawer.png  (抽屉)');
  await ev("document.getElementById('drawerMask').click();");
  await sleep(400);

  // 整页
  const lm = await send('Page.getLayoutMetrics');
  const cs = lm.cssContentSize || lm.contentSize;
  shot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: d.w, height: Math.min(cs.height, 7000), scale: 1.5 }
  });
  fs.writeFileSync(path.join(SHOTS, '15-mobile-full.png'), Buffer.from(shot.data, 'base64'));
  console.log('  SHOT 15-mobile-full.png  (整页 ' + Math.round(Math.min(cs.height, 7000)) + 'px)');
  break;
}

try { chrome.kill(); } catch (e) { /* ignore */ }
try { server.kill(); } catch (e) { /* ignore */ }
await sleep(400);
process.exit(0);
