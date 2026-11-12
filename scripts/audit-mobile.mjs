/**
 * audit-mobile.mjs — 程序化审计手机端布局
 * -------------------------------------------------------------
 * 为什么需要它：当前模型无法查看图片，不能靠"看截图"判断排版好坏。
 * 这个脚本把"排版问题"翻译成可以断言的数字：
 *   · 元素是否重叠
 *   · 文字是否被截断（非 ellipsis 却溢出）
 *   · 关键内容是否超出屏幕宽度
 *   · 页面总高度是否被裁剪
 *
 * 用法：node audit-mobile.mjs [页面地址] [视口宽] [视口高]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 9298;
const PAGE_URL = process.argv[2] || 'http://127.0.0.1:8931/';
const VW = parseInt(process.argv[3] || '390', 10);
const VH = parseInt(process.argv[4] || '844', 10);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(process.env.TEMP || '.', 'am' + Date.now()),
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
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 300);
  return r.result ? r.result.value : undefined;
}

(async () => {
  ws = new WebSocket(await target());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: 2, mobile: true,
    screenWidth: VW, screenHeight: VH
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(6500);
  for (let i = 0; i < 30; i++) {
    const st = await ev("document.getElementById('statusText').textContent");
    if (st && String(st).indexOf('实时数据') >= 0) break;
    await sleep(400);
  }
  await sleep(800);

  console.log('=== 页面结构审计（' + VW + 'x' + VH + '）===\n');

  /* ---- 1. 各区块高度与位置 ---- */
  const blocks = await ev(`(function(){
    var out = [];
    ['hero','days','cards','qaLog'].forEach(function(k){
      var e = document.getElementById(k);
      if (!e) { out.push(k + ': 缺失'); return; }
      var r = e.getBoundingClientRect();
      out.push(k.padEnd(8) + ' top=' + Math.round(r.top) + ' h=' + Math.round(r.height) + ' w=' + Math.round(r.width));
    });
    document.querySelectorAll('.content > .card, .content > .grid-2 > .card, .content > .grid-3 > .card').forEach(function(c){
      var r = c.getBoundingClientRect();
      var t = c.querySelector('.card-title');
      out.push('  CARD ' + (t ? t.textContent.trim().slice(0,14) : '?').padEnd(16) + ' h=' + Math.round(r.height));
    });
    return out.join('\\n');
  })()`);
  console.log(blocks);

  /* ---- 2. 文字截断 ---- */
  const trunc = await ev(`(function(){
    function d(e){ return e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : ''); }
    var bad = [];
    document.querySelectorAll('.card-title, .kpi-t, .kpi-d, .day-dow, .window-date, .window-time, .cd-time').forEach(function(e){
      var cs = getComputedStyle(e);
      if (e.scrollWidth > e.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && cs.overflow !== 'hidden') {
        bad.push(d(e) + ' "' + e.textContent.trim().slice(0,20) + '" scrollW=' + e.scrollWidth + ' clientW=' + e.clientWidth);
      }
    });
    return JSON.stringify(bad.slice(0,10), null, 1);
  })()`);
  console.log('\n=== 文字截断异常 ===');
  console.log(trunc);

  /* ---- 3. 卡片重叠 ---- */
  const overlap = await ev(`(function(){
    var cards = [];
    document.querySelectorAll('.content > .card, .content > .grid-2 > .card').forEach(function(c){
      cards.push({ r: c.getBoundingClientRect(), t: c.querySelector('.card-title') });
    });
    var bad = [];
    for (var i = 0; i < cards.length; i++) {
      for (var j = i + 1; j < cards.length; j++) {
        var a = cards[i].r, b = cards[j].r;
        var vOverlap = !(a.bottom <= b.top + 1 || b.bottom <= a.top + 1);
        var hOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 10;
        if (vOverlap && hOverlap) {
          bad.push('"' + (cards[i].t ? cards[i].t.textContent.trim().slice(0,12) : '?') + '" 与 "' +
                   (cards[j].t ? cards[j].t.textContent.trim().slice(0,12) : '?') + '" 重叠');
        }
      }
    }
    return JSON.stringify(bad, null, 1);
  })()`);
  console.log('\n=== 卡片重叠 ===');
  console.log(overlap);

  /* ---- 4. 关键元素超出屏幕 ---- */
  const offscreen = await ev(`(function(){
    var vw = document.documentElement.clientWidth;
    function d(e){ return e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : ''); }
    var bad = [];
    document.querySelectorAll('.window-date,.window-time,.kpi-t,.conf-badge,.delay-row,.whatif-t').forEach(function(e){
      var r = e.getBoundingClientRect();
      if (r.width === 0) return;
      if (r.right > vw + 2 || r.left < -2) {
        bad.push(d(e) + ' left=' + Math.round(r.left) + ' right=' + Math.round(r.right));
      }
    });
    return JSON.stringify(bad.slice(0,10), null, 1);
  })()`);
  console.log('\n=== 关键元素超出屏幕 ===');
  console.log(offscreen);

  /* ---- 5. 页面高度 ---- */
  const total = await ev(`(function(){
    return JSON.stringify({
      scrollH: document.documentElement.scrollHeight,
      bodyH: document.body.scrollHeight,
      viewH: window.innerHeight,
      ratio: Math.round(document.documentElement.scrollHeight / window.innerHeight * 10) / 10
    }, null, 1);
  })()`);
  console.log('\n=== 页面高度 ===');
  console.log(total);

  /* ---- 6. 关键文案抽查 ---- */
  const texts = await ev(`(function(){
    var out = [];
    var h = document.querySelector('.window-date');
    var t = document.querySelector('.window-time');
    var cd = document.querySelector('.cd-time');
    var k = document.querySelectorAll('.kpi-t');
    var c = document.querySelector('.conf-badge');
    out.push('推荐日: ' + (h ? h.textContent.trim() : '无'));
    out.push('时段:   ' + (t ? t.textContent.trim() : '无'));
    out.push('倒计时: ' + (cd ? cd.textContent.trim() : '无'));
    out.push('判断卡: ' + Array.prototype.map.call(k, function(x){ return x.textContent.trim(); }).join(' / '));
    out.push('置信度: ' + (c ? c.textContent.trim() : '无'));
    return out.join('\\n');
  })()`);
  console.log('\n=== 关键文案 ===');
  console.log(texts);

  /* ---- 7. 分段截图 ---- */
  const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'screenshots');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const shot = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: VW, height: Math.min(VH * 2, 1600), scale: 2 }
    });
    fs.writeFileSync(path.join(outDir, 'audit-mobile.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n  SHOT audit-mobile.png');
  } catch (e) {
    console.log('\n  截图失败: ' + e.message);
  }

  proc.kill();
  await sleep(300);
  process.exit(0);
})();
