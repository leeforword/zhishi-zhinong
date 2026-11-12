/**
 * test-window-card.mjs — 验证窗口置信度卡与反事实推演
 * 用法：node test-window-card.mjs [页面地址]
 *   默认 http://127.0.0.1:8931/，与 start.bat 默认端口一致。
 *   跑批量测试时由 run-all.mjs 传入它自己起的服务器地址，
 *   避免依赖某个特定端口是否在运行。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 9280;
const PAGE_URL = process.argv[2] || 'http://127.0.0.1:8931/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(process.env.TEMP || '.', 'wc' + Date.now()),
  '--window-size=1600,1200', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const errors = [];

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
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 150);
  return r.result ? r.result.value : undefined;
}

let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

(async () => {
  try {
    ws = new WebSocket(await target());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push((m.params.exceptionDetails.exception?.description || '').slice(0, 120));
      }
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 2, mobile: false });
    await send('Page.navigate', { url: PAGE_URL });
    await sleep(6000);

    for (let i = 0; i < 40; i++) {
      const st = await ev("document.getElementById('statusText').textContent");
      if (st && st.indexOf('实时数据') >= 0) break;
      await sleep(500);
    }
    await sleep(1500);

    console.log('=== 窗口置信度卡验证 ===\n');

    console.log('== 1. 集合预报接入 ==');
    const hasEns = await ev("!!(window.TianZhiEnsemble)");
    check(hasEns, 'ensemble.js loaded');
    const srcText = await ev("document.getElementById('srcNote') ? document.getElementById('srcNote').textContent : ''");
    console.log('   数据源: ' + JSON.stringify(srcText));

    console.log('\n== 2. 置信度徽章 ==');
    const badge = await ev("document.querySelector('#heroIn .conf-badge') ? document.querySelector('#heroIn .conf-badge').textContent.trim() : ''");
    console.log('   徽章文字: ' + JSON.stringify(badge));
    check(/置信度/.test(badge || ''), 'confidence badge rendered');
    check(/高|中|低/.test(badge || ''), 'confidence level present');

    console.log('\n== 3. 逐小时支持率条 ==');
    const stripCount = await ev("document.querySelectorAll('#heroIn .conf-strip i').length");
    console.log('   条数: ' + stripCount);
    check(stripCount >= 2, 'confidence strip has ' + stripCount + ' cells');
    const t1 = await ev("document.querySelector('#heroIn .conf-strip i') ? document.querySelector('#heroIn .conf-strip i').getAttribute('title') : ''");
    console.log('   首格提示: ' + JSON.stringify(t1));

    console.log('\n== 4. 窗口关闭条件 ==');
    const cc = await ev("document.querySelector('#heroIn .close-cond') ? document.querySelector('#heroIn .close-cond').textContent.trim() : ''");
    console.log('   ' + JSON.stringify((cc || '').slice(0, 150)));
    check(/窗口关闭条件/.test(cc || ''), 'close condition rendered');

    console.log('\n== 5. 推迟代价 ==');
    const delay = await ev("document.querySelector('#heroIn .delay-row') ? document.querySelector('#heroIn .delay-row').textContent.trim() : ''");
    console.log('   ' + JSON.stringify((delay || '').slice(0, 160)));
    check((delay || '').length > 0, 'delay cost rendered');

    console.log('\n== 6. 反事实推演按钮 ==');
    const btns = await ev("Array.from(document.querySelectorAll('.whatif-btns button')).map(function(b){return b.textContent})");
    console.log('   按钮: ' + JSON.stringify(btns));
    check(Array.isArray(btns) && btns.length >= 4, 'what-if buttons rendered');

    console.log('\n== 7. 点按钮真的重算 ==');
    // 优先点一个"会改变结论"的假设；没有就点第一个
    const clicked = await ev(`(function(){
      var b = document.querySelector('.whatif-btns button.flips') ||
              document.querySelector('[data-whatif="wind20"]') ||
              document.querySelector('.whatif-btns button');
      if (!b) return 'no-btn';
      b.click();
      return 'clicked:' + (b.getAttribute('data-whatif') || '?');
    })()`);
    check(String(clicked).indexOf('clicked') === 0, 'clicked what-if button (' + clicked + ')');
    await sleep(600);
    const outTxt = await ev("document.getElementById('whatifOut') ? document.getElementById('whatifOut').textContent.trim() : ''");
    console.log('   结果: ' + JSON.stringify((outTxt || '').slice(0, 220)));
    check(/默认规则/.test(outTxt || ''), 'shows baseline result');
    check(/小时/.test(outTxt || '') || /无窗口/.test(outTxt || ''), 'shows recomputed result');
    check(/结论(发生改变|没变)|结论改变/.test(outTxt || ''), 'shows flip verdict');

    const hasFlipClass = await ev("!!document.querySelector('.wf-row b.flip')");
    console.log('   结论翻转标记: ' + hasFlipClass);

    console.log('\n== 8. 另一个假设 ==');
    await ev(`(function(){
      var b = document.querySelector('[data-whatif="wind50"]') ||
              document.querySelector('.whatif-btns button');
      b.click();
    })()`);
    await sleep(600);
    const out2 = await ev("document.getElementById('whatifOut').textContent.trim()");
    console.log('   ' + JSON.stringify((out2 || '').slice(0, 200)));
    check(out2.length > 10, 'second what-if works');

    console.log('\n== 8b. 恢复默认 ==');
    await ev("document.querySelector('[data-whatif=\"reset\"]').click();");
    await sleep(400);
    const out3 = await ev("document.getElementById('whatifOut').textContent.trim()");
    check(out3 === '', 'reset clears output');

    console.log('\n== 9. 未捕获异常 ==');
    console.log('   ' + (errors.length ? errors.slice(0, 3).join(' | ') : '无'));
    check(errors.length === 0, 'no uncaught exceptions');

    console.log('\n== 10. 布局无溢出 ==');
    const overflow = await ev("document.documentElement.scrollWidth > document.documentElement.clientWidth");
    check(!overflow, 'no horizontal overflow');

    // 截图
    const box = JSON.parse(await ev(`(function(){
      var c = document.getElementById('hero').closest('.card');
      var r = c.getBoundingClientRect();
      return JSON.stringify({x:r.left,y:r.top,width:r.width,height:r.height});
    })()`));
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 }
    });
    const outDir = path.resolve('..', 'screenshots');
    fs.writeFileSync(path.join(outDir, '08-window-confidence.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n   SHOT 08-window-confidence.png');

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
