/**
 * check-scrollable.mjs — 判断页面是否真的能横向滑动
 * -------------------------------------------------------------
 * 为什么不能用 scrollWidth > clientWidth 判断：
 *   背景层 .bg-blobs 用 inset:-20% 故意超出，被 .bg-layer 的
 *   overflow:hidden 裁剪掉了。但 scrollWidth 仍然把这部分算进去，
 *   导致 8–10px 的假阳性，看起来"溢出"，实际用户根本滑不动。
 *
 * 唯一可靠的判据：真的调用 scrollTo 试试能不能滑。
 *
 * 用法：node check-scrollable.mjs [页面地址]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 9308;
const PAGE_URL = process.argv[2] || 'http://127.0.0.1:8931/';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(process.env.TEMP || '.', 'cs' + Date.now()),
  'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const l = await r.json();
      const p = l.find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { /* retry */ }
    await sleep(200);
  }
  throw new Error('CDP 连接失败');
}
function send(m, p) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  return new Promise(r => pending.set(i, r));
}
async function ev(x) {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200);
  return r.result ? r.result.value : undefined;
}

const CHECK = `(function(){
  var de = document.documentElement;
  var before = window.scrollX;
  window.scrollTo(9999, 0);
  var after = window.scrollX;
  window.scrollTo(before, 0);
  return JSON.stringify({
    canScrollRight: after > 0,
    maxScrollX: after,
    scrollW: de.scrollWidth,
    clientW: de.clientWidth,
    innerW: window.innerWidth
  });
})()`;

const SIZES = [
  { n: 'iPhone 14', w: 390, h: 844 },
  { n: 'iPhone SE', w: 375, h: 667 },
  { n: 'Android  ', w: 360, h: 800 },
  { n: 'iPad     ', w: 768, h: 1024 },
  { n: '桌面     ', w: 1280, h: 900 }
];

(async () => {
  ws = new WebSocket(await target());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  await send('Runtime.enable');
  await send('Page.enable');

  console.log('=== 横向可滑动性检查 ===\n');
  let bad = 0;
  for (const s of SIZES) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: s.w, height: s.h, deviceScaleFactor: 2,
      mobile: s.w <= 640, screenWidth: s.w, screenHeight: s.h
    });
    await send('Page.navigate', { url: PAGE_URL });
    await sleep(5000);

    const r = JSON.parse(await ev(CHECK));
    const ok = !r.canScrollRight;
    if (!ok) bad++;
    console.log(
      '  ' + s.n + ' ' + String(s.w).padStart(4) + 'px  ' +
      (ok ? '✔ 不可横滑' : '✘ 可横滑 ' + r.maxScrollX + 'px') +
      '   (scrollW=' + r.scrollW + ' clientW=' + r.clientW + ')'
    );
  }

  console.log('\n' + (bad === 0 ? '  全部正常，页面无横向溢出' : '  ' + bad + ' 个尺寸存在横向溢出'));
  proc.kill();
  await sleep(300);
  process.exit(bad ? 1 : 0);
})();
