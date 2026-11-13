/**
 * e2e.mjs — browser end-to-end test (Chrome Headless + CDP, zero dependencies)
 *
 * Assertion messages are ASCII only on purpose:
 * Windows PowerShell has corrupted this file's encoding before.
 *
 * Usage: node e2e.mjs [url] [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_URL = process.argv[2] || 'http://127.0.0.1:8931/';
const OUT = process.argv[3] || '../screenshots';
const PORT = 9245;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('Chrome/Edge not found'); process.exit(1); }

const userDataDir = path.join(process.env.TEMP || '.', 'cdp_e2e_' + Date.now());
fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + userDataDir,
  '--window-size=1600,1200', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (err) { /* not ready */ }
    await sleep(250);
  }
  throw new Error('CDP connect failed');
}

let ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

function send(method, params) {
  params = params || {};
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); }
    }, 30000);
  });
}

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('JS exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 250));
  }
  return r.result ? r.result.value : undefined;
}

let pass = 0, fail = 0;
const check = (c, m) => {
  if (c) { pass++; console.log('  PASS ' + m); }
  else { fail++; console.log('  FAIL ' + m); }
};

async function device(w, h, mobile, dpr) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: dpr || 1, mobile: !!mobile
  });
}

async function shotViewport(file) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  console.log('  SHOT ' + file);
}

async function shotFit(file) {
  await device(1600, 300, false, 1);
  await sleep(350);
  // 用 layout metrics 量真实内容尺寸（body rect 在 sticky/sidebar 布局下会偏小）
  const lm = await send('Page.getLayoutMetrics');
  const cs = lm.cssContentSize || lm.contentSize;
  const h = Math.ceil(cs.height);
  const w = Math.ceil(cs.width);
  await device(Math.max(w, 1200), Math.min(Math.max(h, 700), 6000), false, 2);
  await sleep(500);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  console.log('  SHOT ' + file);
  await device(1600, 1200, false, 1);
  await sleep(300);
}

async function shotFull(file) {
  const m = await send('Page.getLayoutMetrics');
  const s = m.cssContentSize || m.contentSize;
  const r = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: s.width, height: s.height, scale: 1 }
  });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  console.log('  SHOT ' + file);
}

async function waitData(timeoutMs) {
  const t0 = Date.now();
  const limit = timeoutMs || 22000;
  while (Date.now() - t0 < limit) {
    const st = await ev("document.getElementById('statusText').textContent");
    if (st.indexOf('实时数据') >= 0) return true;
    if (st.indexOf('失败') >= 0) return false;
    await sleep(400);
  }
  return false;
}

(async () => {
  try {
    ws = new WebSocket(await getTarget());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });

    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push(m.params.args.map(a => a.value || a.description || '').join(' '));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const ex = m.params.exceptionDetails;
        pageErrors.push((ex && ex.exception && ex.exception.description) || 'unknown');
      }
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await device(1600, 1200, false, 1);

    /* ---------- 1 ---------- */
    console.log('\n== 1. page load ==');
    await send('Page.navigate', { url: PAGE_URL });
    await sleep(1200);
    check(pageErrors.length === 0, 'no uncaught exception' + (pageErrors.length ? ': ' + pageErrors[0].slice(0, 150) : ''));
    check(consoleErrors.length === 0, 'no console error' + (consoleErrors.length ? ': ' + consoleErrors[0].slice(0, 150) : ''));

    /* ---------- 2 ---------- */
    console.log('\n== 2. weather data ==');
    check(await waitData(), 'weather loaded');
    const dayCount = await ev("document.querySelectorAll('#days .day').length");
    check(dayCount === 7, 'seven day cells: ' + dayCount);
    const cardCount = await ev("document.querySelectorAll('#cards .kpi-item').length");
    check(cardCount === 3, 'three judgement cards: ' + cardCount);

    const heroText = await ev("document.querySelector('#heroIn').textContent");
    check(heroText.length > 10, 'hero rendered');
    check(heroText.indexOf('undefined') < 0, 'hero has no undefined');
    const todayTxt = await ev("document.getElementById('todayDate').textContent");
    check(todayTxt.indexOf('undefined') < 0 && todayTxt.length > 2, 'masthead date ok: ' + todayTxt);

    check(await ev("!document.getElementById('consensusBox')"), 'consensus block removed');

    await shotViewport('01-desktop-overview.png');

    /* ---------- 3 ---------- */
    console.log('\n== 3. charts ==');
    check(await ev("!!document.querySelector('#windChart svg')"), 'wind chart svg');
    check((await ev("document.querySelectorAll('#windChart path').length")) >= 2, 'wind chart area + line');
    check(await ev(
      "Array.from(document.querySelectorAll('#windChart line')).some(function(l){return l.getAttribute('stroke-dasharray')})"
    ), 'wind chart threshold line');
    const heatRects = await ev("document.querySelectorAll('#heatChart rect').length");
    check(heatRects >= 168, 'heatmap 7x24 cells: ' + heatRects);
    check(await ev("!!document.querySelector('#tempChart svg')"), 'temp chart svg');
    // v2 首页把环形图换成了适配度环，断言跟着换
    const gaugeArc = await ev("(() => { const a = document.getElementById('gaugeArc'); return a ? Number(a.getAttribute('stroke-dashoffset')) : -1; })()");
    check(gaugeArc >= 0 && gaugeArc <= 346, 'gauge arc drawn: ' + gaugeArc);
    check(await ev("!!document.querySelector('#growthChart svg')"), 'growth chart svg');

    await shotFit('02-charts.png');

    /* ---------- 4 ---------- */
    console.log('\n== 4. day switch + task switch ==');
    const t0 = await ev("document.getElementById('windTitle').textContent");
    await ev("document.querySelectorAll('#days .day')[3].click();");
    await sleep(700);
    const t1 = await ev("document.getElementById('windTitle').textContent");
    check(t0 !== t1, 'chart title follows day selection');

    // 作业类型切换：打药 -> 灌溉 -> 晾晒
    const sprayTxt = await ev("document.querySelectorAll('#days .day .day-state')[1].textContent");
    await ev("document.querySelector('#taskSwitch [data-task=\"irrigation\"]').click();");
    await sleep(400);
    const irrTxt = await ev("document.querySelectorAll('#days .day .day-state')[1].textContent");
    check(/灌溉/.test(irrTxt), 'irrigation verdict shown: ' + irrTxt);
    check(sprayTxt !== irrTxt, 'task switch changes verdict text');

    await ev("document.querySelector('#taskSwitch [data-task=\"harvest\"]').click();");
    await sleep(400);
    const harvTxt = await ev("document.querySelectorAll('#days .day .day-state')[1].textContent");
    check(/晾晒/.test(harvTxt), 'harvest verdict shown: ' + harvTxt);

    // 切回打药，避免影响后续截图
    await ev("document.querySelector('#taskSwitch [data-task=\"spray\"]').click();");
    await sleep(400);

    // 预设城市按钮必须已移除
    check(await ev("!document.getElementById('presetChips')"), 'preset city chips removed');

    // 名称已改为知时智农
    check(/知时智农/.test(await ev("document.querySelector('.brand-name').textContent")), 'brand renamed to 知时智农');
    check(/知时智农/.test(await ev("document.title")), 'document title renamed');

    /* ---------- 5 ---------- */
    console.log('\n== 5. add plot ==');
    await ev("document.getElementById('plotMask').classList.remove('on')");
    await sleep(200);
    const before = await ev("document.querySelectorAll('#plotList .plot').length");
    await ev("document.getElementById('addPlotBtn').click();");
    await sleep(600);
    check(await ev("document.getElementById('plotMask').classList.contains('on')"), 'modal opened');

    await ev("document.getElementById('mapToggle').click();");
    await sleep(2500);
    let mode = '', amapReady = false;
    for (let i = 0; i < 25; i++) {
      mode = await ev("document.getElementById('mapMode').textContent");
      amapReady = await ev("!!(window.AMap && window.__tzMap && typeof window.__tzMap.getCenter === 'function')");
      if (amapReady && (mode.indexOf('高德') >= 0 || mode.indexOf('示意') >= 0)) break;
      await sleep(500);
    }
    check(amapReady, 'AMap rendered: ' + mode);

    check(await ev("window.__tzPickCenter && window.__tzPickCenter()") === true, 'map pick triggered');
    await sleep(900);
    const coord = await ev("document.getElementById('mapCoord').textContent");
    check(coord.indexOf('N') >= 0, 'picked coordinate: ' + coord);
    check(await ev(`
      (function(){
        var m = document.getElementById('mapCoord').textContent.match(/([\\d.]+)°N, ([\\d.]+)°E/);
        if (!m) return false;
        var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
        return lat > 35 && lat < 43 && lon > 112 && lon < 121;
      })()
    `), 'coordinate inside Hebei after GCJ->WGS');

    await shotViewport('03-map-pick.png');

    // 地点入口只剩搜索框：用搜索来设定地点
    await ev("document.getElementById('fLoc').value='沧州';");
    await ev("document.getElementById('fSearchBtn').click();");
    await sleep(600);
    const firstResult = await ev(`
      (function(){
        var r = document.querySelector('#fResults .result-item');
        if (!r) return 'no-result';
        r.click();
        return 'clicked';
      })()
    `);
    await sleep(400);
    const hintTxt = await ev("document.getElementById('fHint').textContent");
    check(firstResult === 'clicked' && hintTxt.indexOf('沧州') >= 0, 'search sets place: ' + hintTxt);

    await ev("document.getElementById('fName').value='测试地块';");
    await ev("document.getElementById('fArea').value='12';");
    check(await ev(`
      (function(){
        var b = document.getElementById('modalSave').getBoundingClientRect();
        return b.bottom <= window.innerHeight && b.top >= 0;
      })()
    `), 'save button visible without scroll');
    await shotViewport('04-plot-manage.png');
    await ev("document.getElementById('modalSave').click();");
    await sleep(2500);
    const after = await ev("document.querySelectorAll('#plotList .plot').length");
    check(after === before + 1, 'plot count ' + before + ' -> ' + after);
    check(await waitData(), 'new plot weather loaded');

    /* ---------- 5b ---------- */
    console.log('\n== 5b. map drag keeps modal open ==');
    await ev("document.getElementById('addPlotBtn').click();");
    await sleep(600);
    await ev("document.getElementById('mapToggle').click();");
    await sleep(2500);
    const box = JSON.parse(await ev(`
      (function(){
        var s = document.getElementById('mapStage').getBoundingClientRect();
        return JSON.stringify({x:s.left+s.width/2, y:s.top+s.height/2});
      })()
    `));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - i * 30, y: box.y - i * 20, button: 'left', buttons: 1 });
      await sleep(50);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 40, button: 'left', buttons: 0 });
    await sleep(900);
    check(await ev("document.getElementById('plotMask').classList.contains('on')"), 'modal still open after map drag');
    await ev("document.getElementById('modalCancel').click();");
    await sleep(300);

    /* ---------- 6 ---------- */
    console.log('\n== 6. edit ==');
    await ev(`
      (function(){
        var ps = document.querySelectorAll('#plotList .plot');
        ps[ps.length-1].querySelector('button[data-act="edit"]').click();
      })()
    `);
    await sleep(600);
    await ev("document.getElementById('fName').value='改名后地块';");
    await ev("document.getElementById('fCrop').value='maize';");
    await ev("document.getElementById('modalSave').click();");
    await sleep(2200);
    const joined = await ev("Array.from(document.querySelectorAll('#plotList .plot-name')).map(function(e){return e.textContent}).join(',')");
    check(joined.indexOf('改名后地块') >= 0, 'edit applied');
    const cropTxt = await ev(`
      (function(){
        var ps = document.querySelectorAll('#plotList .plot');
        return ps[ps.length-1].querySelector('.plot-crop').textContent;
      })()
    `);
    check(cropTxt.indexOf('玉米') >= 0, 'crop changed to maize');

    /* ---------- 7 ---------- */
    console.log('\n== 7. persistence ==');
    await send('Page.reload');
    await sleep(1600);
    await waitData();
    check(await ev("document.querySelectorAll('#plotList .plot').length") === after, 'plot count survives reload');
    const joined2 = await ev("Array.from(document.querySelectorAll('#plotList .plot-name')).map(function(e){return e.textContent}).join(',')");
    check(joined2.indexOf('改名后地块') >= 0, 'edit survives reload');

    /* ---------- 8 ---------- */
    console.log('\n== 8. inline delete ==');
    const cntBefore = await ev("document.querySelectorAll('#plotList .plot').length");
    await ev(`
      (function(){
        var ps = document.querySelectorAll('#plotList .plot');
        ps[ps.length-1].querySelector('button[data-act="del"]').click();
      })()
    `);
    await sleep(400);
    check(await ev("!!document.querySelector('#plotList .plot.confirming')"), 'inline confirm shown');
    await ev("document.querySelector('#plotList .plot.confirming button[data-act=\"cancel\"]').click();");
    await sleep(300);
    check(await ev("document.querySelectorAll('#plotList .plot').length") === cntBefore, 'cancel keeps plot');
    await ev(`
      (function(){
        var ps = document.querySelectorAll('#plotList .plot');
        ps[ps.length-1].querySelector('button[data-act="del"]').click();
      })()
    `);
    await sleep(300);
    await ev("document.querySelector('#plotList .plot.confirming button[data-act=\"confirm\"]').click();");
    await sleep(2200);
    check(await ev("document.querySelectorAll('#plotList .plot').length") === cntBefore - 1, 'confirm deletes plot');

    /* ---------- 9 ---------- */
    console.log('\n== 9. QA and LLM ==');
    await send('Page.navigate', { url: PAGE_URL });
    await sleep(2000);
    await waitData();
    const n0 = await ev("document.querySelectorAll('#qaLog .msg').length");
    await ev("document.querySelectorAll('.chip-btn')[0].click();");
    let ans = '';
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      const done = await ev("!document.querySelector('#qaLog .typing')");
      const cnt = await ev("document.querySelectorAll('#qaLog .msg').length");
      if (done && cnt >= n0 + 2) {
        ans = await ev("[...document.querySelectorAll('#qaLog .msg.bot')].pop().textContent");
        break;
      }
    }
    check(ans.length > 0, 'QA answer received');
    check(ans.indexOf('NaN') < 0 && ans.indexOf('undefined') < 0, 'answer has no NaN');

    check(await ev("window.TianZhiLLM && window.TianZhiLLM.hasKey()"), 'LLM config loaded');
    const c1 = JSON.parse(await ev("JSON.stringify(window.TianZhiLLM.numbersConsistent('10:00-14:00 风速1.9','10:00-14:00 风速 1.9'))"));
    check(c1.ok === true, 'number guard: identical numbers pass');
    const c2 = JSON.parse(await ev("JSON.stringify(window.TianZhiLLM.numbersConsistent('10:00-14:00 风速1.9','明天风速1.5'))"));
    check(c2.ok === false && c2.extra.indexOf('1.5') >= 0, 'number guard: new number blocked');

    /* ---------- 10 ---------- */
    console.log('\n== 10. file protocol ==');
    pageErrors.length = 0; consoleErrors.length = 0;
    const fileUrl = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
    await send('Page.navigate', { url: fileUrl });
    await sleep(1800);
    check(await waitData(), 'weather loads over file protocol');
    check(await ev("document.querySelectorAll('#days .day').length") === 7, 'seven days over file protocol');
    check(pageErrors.length === 0, 'no JS error over file protocol');
    check((await ev("document.querySelectorAll('svg.chart').length")) >= 4, 'charts render over file protocol');

    /* ---------- 11 ---------- */
    console.log('\n== 11. mobile ==');
    await send('Page.navigate', { url: PAGE_URL });
    await sleep(2000);
    await waitData();
    await device(390, 844, true, 2);
    await sleep(1200);
    const cols = await ev("getComputedStyle(document.querySelector('.app')).gridTemplateColumns");
    check(cols.trim().split(/\s+/).length === 1, 'single column on mobile: ' + cols);
    const overflow = await ev("document.documentElement.scrollWidth - window.innerWidth");
    check(overflow <= 2, 'no horizontal overflow: ' + overflow + 'px');
    await shotFull('05-mobile.png');

    console.log('\n===== RESULT: pass ' + pass + ' / fail ' + fail + ' =====');
    if (pageErrors.length) console.log('page errors:', pageErrors.slice(0, 3));
    if (consoleErrors.length) console.log('console errors:', consoleErrors.slice(0, 3));
    ws.close(); proc.kill();
    await sleep(600);
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.error('\nFATAL: ' + err.message);
    try { proc.kill(); } catch (e2) { /* ignore */ }
    process.exit(1);
  }
})();
