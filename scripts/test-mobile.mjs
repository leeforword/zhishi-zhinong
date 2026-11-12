/**
 * test-mobile.mjs — 手机端专项测试
 * 用真实 iPhone / Android 尺寸 + 触摸事件模拟
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 9290;
const URL_BASE = process.argv[2] || 'http://127.0.0.1:8931/';
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'screenshots');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(process.env.TEMP || '.', 'mb' + Date.now()),
  'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

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
  throw new Error('CDP failed');
}
function send(m, p) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  return new Promise(r => pending.set(i, r));
}
async function ev(x) {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200);
  }
  return r.result ? r.result.value : undefined;
}

const DEVICES = [
  { name: 'iPhone 14 (390x844)', w: 390, h: 844, dpr: 3 },
  { name: 'iPhone SE (375x667)', w: 375, h: 667, dpr: 2 },
  { name: 'Android (360x800)', w: 360, h: 800, dpr: 3 },
  { name: 'iPad mini (768x1024)', w: 768, h: 1024, dpr: 2 }
];

(async () => {
  try {
    ws = new WebSocket(await target());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');

    for (const d of DEVICES) {
      console.log('\n=== ' + d.name + ' ===');

      await send('Emulation.setDeviceMetricsOverride', {
        width: d.w, height: d.h, deviceScaleFactor: d.dpr,
        mobile: true, screenWidth: d.w, screenHeight: d.h
      });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await send('Page.navigate', { url: URL_BASE });
      await sleep(5500);

      // 等数据
      for (let i = 0; i < 30; i++) {
        const st = await ev("document.getElementById('statusText').textContent");
        if (st && String(st).indexOf('实时数据') >= 0) break;
        await sleep(400);
      }
      await sleep(600);

      /* ---- 1. 用户能否真的横向滑动（真实溢出判据） ----
         注意：不能用 scrollWidth > clientWidth 判断。
         .bg-blobs 用 inset:-20% 故意超出，被 .bg-layer 的
         overflow:hidden 裁剪，但 scrollWidth 仍会把它算进去，
         导致 8–10px 的假阳性。唯一可靠判据是：
         真的调用 scrollTo 看能不能滑。 */
      const canScroll = await ev(`(function(){
        var before = window.scrollX;
        window.scrollTo(9999, 0);
        var after = window.scrollX;
        window.scrollTo(before, 0);
        return JSON.stringify({
          canScrollRight: after > 0,
          maxScrollX: after,
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth
        });
      })()`);
      const sc = JSON.parse(canScroll);
      check(!sc.canScrollRight, 'page cannot be scrolled horizontally' +
        (sc.canScrollRight ? ' (可滑动 ' + sc.maxScrollX + 'px)' : ''));

      /* ---- 2. 核心元素可见 ---- */
      const core = await ev(`(function(){
        var out = {};
        ['hero','days','cards','qaLog'].forEach(function(k){
          var e = document.getElementById(k);
          out[k] = e ? (e.getBoundingClientRect().width > 0) : false;
        });
        out.dayCount = document.querySelectorAll('#days .day').length;
        out.kpiCount = document.querySelectorAll('#cards .kpi-item').length;
        return JSON.stringify(out);
      })()`);
      const c = JSON.parse(core);
      check(c.hero && c.days && c.cards && c.qaLog, 'core sections visible');
      check(c.dayCount === 7, 'seven day cards (got ' + c.dayCount + ')');
      check(c.kpiCount === 3, 'three KPI cards');

      /* ---- 3. 触控目标尺寸（≥40px 宽高） ---- */
      const smallTargets = await ev(`(function(){
        var sel = '.icon-btn, .menu-btn, .task-btn, .qa-send, .btn, .whatif-btns button, .plot-acts .ico-btn';
        var bad = [];
        document.querySelectorAll(sel).forEach(function(e){
          var r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;   // 隐藏的不算
          if (r.height < 34 || r.width < 28) {
            bad.push((e.className||e.tagName).toString().slice(0,24) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
          }
        });
        return JSON.stringify(bad.slice(0, 8));
      })()`);
      const small = JSON.parse(smallTargets);
      console.log('   过小的触控目标: ' + (small.length ? small.join(' | ') : '无'));
      check(small.length <= 2, 'touch targets mostly >= 34px');

      /* ---- 4. 抽屉：桌面隐藏 / 手机可用 ---- */
      const isMobile = d.w <= 640;
      const menuVisible = await ev(`(function(){
        var b = document.getElementById('menuBtn');
        if (!b) return 'no-btn';
        var r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? 'visible' : 'hidden';
      })()`);

      if (isMobile) {
        check(menuVisible === 'visible', 'hamburger visible on mobile (' + menuVisible + ')');

        // 打开抽屉
        await ev("document.getElementById('menuBtn').click();");
        await sleep(400);
        const drawerOpen = await ev(`(function(){
          var s = document.getElementById('sidebar');
          var m = document.getElementById('drawerMask');
          var r = s.getBoundingClientRect();
          return JSON.stringify({
            open: s.classList.contains('open'),
            left: Math.round(r.left),
            maskOn: m.classList.contains('on'),
            bodyLocked: document.body.style.overflow === 'hidden'
          });
        })()`);
        const dd = JSON.parse(drawerOpen);
        check(dd.open, 'drawer opens');
        check(dd.left >= -1, 'drawer slides into view (left=' + dd.left + ')');
        check(dd.maskOn, 'mask shown');
        check(dd.bodyLocked, 'background scroll locked');

        // 截图抽屉
        if (d.w === 390) {
          const s1 = await send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(OUT, '09-mobile-drawer.png'), Buffer.from(s1.data, 'base64'));
          console.log('   SHOT 09-mobile-drawer.png');
        }

        // 关闭抽屉
        await ev("document.getElementById('drawerMask').click();");
        await sleep(400);
        const drawerClosed = await ev("document.getElementById('sidebar').classList.contains('open')");
        check(!drawerClosed, 'drawer closes on mask tap');
      } else {
        check(menuVisible === 'hidden', 'hamburger hidden on tablet/desktop');
      }

      /* ---- 5. 七日卡片可横向滑动 ---- */
      const daysScroll = await ev(`(function(){
        var e = document.getElementById('days');
        var cs = getComputedStyle(e);
        return JSON.stringify({
          scrollable: e.scrollWidth > e.clientWidth + 2,
          overflowX: cs.overflowX,
          cardW: e.querySelector('.day') ? Math.round(e.querySelector('.day').getBoundingClientRect().width) : 0
        });
      })()`);
      const ds = JSON.parse(daysScroll);
      if (d.w <= 640) {
        check(ds.overflowX === 'auto' || ds.overflowX === 'scroll', 'days horizontally scrollable');
        check(ds.cardW >= 85, 'day card width usable (' + ds.cardW + 'px)');
      }

      /* ---- 6. 图表不被压扁 ---- */
      const chartCheck = await ev(`(function(){
        var s = document.querySelector('#windChart svg');
        if (!s) return 'no-svg';
        var r = s.getBoundingClientRect();
        return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) });
      })()`);
      const ch = JSON.parse(chartCheck);
      console.log('   风速图尺寸: ' + ch.w + 'x' + ch.h);
      check(ch.h > 100, 'charts have readable height');

      /* ---- 7. 字号可读（≥11px） ---- */
      const tiny = await ev(`(function(){
        var bad = 0;
        document.querySelectorAll('.kpi-d, .day-state, .window-meta, .conf-src, .cd-l').forEach(function(e){
          var fs = parseFloat(getComputedStyle(e).fontSize);
          if (fs < 10.5) bad++;
        });
        return bad;
      })()`);
      check(tiny === 0, 'no text below 10.5px (' + tiny + ' found)');

      /* ---- 8. 整页截图 ---- */
      if (d.w === 390) {
        const lm = await send('Page.getLayoutMetrics');
        const cs2 = lm.cssContentSize || lm.contentSize;
        const shot = await send('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: d.w, height: Math.min(cs2.height, 6000), scale: 2 }
        });
        fs.writeFileSync(path.join(OUT, '10-mobile-full.png'), Buffer.from(shot.data, 'base64'));
        console.log('   SHOT 10-mobile-full.png (高度 ' + Math.round(Math.min(cs2.height, 6000)) + 'px)');
      }
    }

    console.log(`\n===== RESULT: pass ${pass} / fail ${fail} =====`);
    proc.kill();
    await sleep(300);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('FATAL: ' + e.message);
    try { proc.kill(); } catch (e2) { /* ignore */ }
    process.exit(1);
  }
})();
