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
    throw new Error('JS exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 900));
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
    console.log('\n== 2. weather data / L1 decision ==');
    check(await waitData(), 'weather loaded');
    const wkCount = await ev("document.querySelectorAll('#weekStrip .wk').length");
    check(wkCount === 7, 'seven window slots: ' + wkCount);
    const metricCount = await ev("document.querySelectorAll('#dMetrics .d-metric').length");
    check(metricCount === 4, 'four checkable metrics: ' + metricCount);

    /* v5 的核心：先回答「这件活今天能不能干」，不能干才顺带给下一次机会 */
    const dWord = await ev("document.getElementById('dWord').textContent");
    const dWhy = await ev("document.getElementById('dWhy').textContent");
    check(dWord.length >= 4, 'verdict rendered: ' + dWord);
    check(/今天|现在|这七天/.test(dWord), 'verdict answers today first: ' + dWord);
    check(dWhy.length > 12 && dWhy.indexOf('undefined') < 0 && dWhy.indexOf('NaN') < 0,
      'reason is specific and clean');
    check(dWhy.indexOf('下一次机会') < 0 || dWord.indexOf('不能打') >= 0,
      'next chance only attached to a no-today verdict');
    const todayTxt = await ev("document.getElementById('todayDate').textContent");
    check(/月/.test(todayTxt) && todayTxt.indexOf('undefined') < 0, 'masthead date ok: ' + todayTxt);
    check(await ev("document.getElementById('dMeta').textContent.indexOf('标准') >= 0"),
      'standard source shown on decision card');
    /* 决策卡背景跟天气走（晴/阴/雨/雪/雾/雷/风/夜），不再是纯白模板卡 */
    check(await ev("/wx-(clear|cloud|rain|snow|fog|storm|wind|night)/.test(document.getElementById('decision').className)"),
      'decision card carries weather theme');
    /* v5.1：决策卡随天气换博物志插画，物候横幅按月份显示 */
    check(await ev("/img\\/weather-/.test(document.getElementById('dArt').getAttribute('src')||'')"),
      'decision card carries weather illustration');
    check(await ev("!!document.getElementById('seasonBanner')"), 'season banner element exists');

    check(await ev("!document.getElementById('consensusBox')"), 'consensus block removed');

    await shotViewport('01-desktop-overview.png');

    /* ---------- 3 ---------- */
    console.log('\n== 3. charts ==');
    /* 23 点之后和风的 168h 从明天 0 点起算，今天没有逐小时数据，
       风速图会显示「该日无逐小时数据」——那不叫坏，断言要认这种情况。 */
    const windEmpty = await ev("/无逐小时数据/.test(document.getElementById('windChart').textContent)");
    check(windEmpty || await ev("!!document.querySelector('#windChart svg')"), 'wind chart svg');
    check(windEmpty || (await ev("document.querySelectorAll('#windChart path').length")) >= 2, 'wind chart area + line');
    check(windEmpty || await ev(
      "Array.from(document.querySelectorAll('#windChart line')).some(function(l){return l.getAttribute('stroke-dasharray')})"
    ), 'wind chart threshold line');
    const heatRects = await ev("document.querySelectorAll('#heatChart rect').length");
    check(heatRects >= 168, 'heatmap 7x24 cells: ' + heatRects);
    check(await ev("!!document.querySelector('#tempChart svg')"), 'temp chart svg');
    // v5：不再有评分环 / 适配度，四项原值直接摆在决策卡上，可逐项核对
    check(await ev("document.querySelectorAll('#dMetrics .d-metric b').length") === 4,
      'four checkable metrics on decision card');
    check(await ev("/[0-9]/.test(document.getElementById('dWhy').textContent)"),
      'reason cites real measured values');
    check(await ev("!!document.querySelector('#growthChart svg')"), 'growth chart svg');

    /* v4.7：统一骨架；v5.1 起八张卡 2×N 网格，每一行必须等高对齐 */
    const pair = await ev(`(() => {
      const cards = [...document.querySelectorAll('.chart-card')];
      const out = { n: cards.length, bad: [] };
      for (let r = 0; r * 2 + 1 < cards.length; r++) {
        const a = cards[r * 2].getBoundingClientRect(), b = cards[r * 2 + 1].getBoundingClientRect();
        const sa = cards[r * 2].querySelector('svg'), sb = cards[r * 2 + 1].querySelector('svg');
        const dh = Math.abs(a.height - b.height), dy = Math.abs(a.top - b.top);
        const sh = sa && sb ? Math.abs(sa.getBoundingClientRect().height - sb.getBoundingClientRect().height) : 0;
        if (dh > 1 || dy > 1 || sh > 1) out.bad.push(r + ' (dh ' + dh.toFixed(1) + ' sh ' + sh.toFixed(1) + ')');
      }
      return out;
    })()`);
    check(pair.n === 8, 'eight chart cards in a 2-column grid: ' + pair.n);
    check(pair.bad.length === 0, 'every row aligned: ' + (pair.bad.join('; ') || 'all rows OK'));

    /* v5.1 新增四张：露点差 / 气温带 / 风向飘移 / 降雨需水 */
    check(await ev("!!document.querySelector('#dewChart svg') && /结露线/.test(document.getElementById('dewChart').textContent)"),
      'dew-gap chart with condensation threshold');
    check(await ev("!!document.querySelector('#tempBandChart svg')"), 'temperature band chart');
    check(await ev("(function(){var c=document.querySelector('#driftChart');return c && c.querySelectorAll('line').length >= 20;})()"),
      'drift chart with arrow glyphs');
    check(await ev("!!document.querySelector('#rainChart svg') && /周参考/.test(document.getElementById('rainChart').textContent)"),
      'rain vs water-need chart with weekly reference');
    check(await ev("document.querySelectorAll('#heatChart text').length") > 8, 'heatmap axis labels');

    /* 风向不该再出现「西西南 / 西西北」这种记录式写法 */
    const dirTxt = await ev("[...document.querySelectorAll('#proTable td')].map(td=>td.textContent).join(' ')");
    check(dirTxt.length > 0 && !/西西南|西西北|北东北|东东南|南东南/.test(dirTxt),
      'wind direction readable (no 西西南 style)');
    check(/°/.test(dirTxt), 'wind direction carries degrees');

    /* 详细数据：桌面默认展开，实况 11 项，逐时表 24 行 */
    check(await ev("document.getElementById('basisPanel').open === true"), 'evidence panel open on desktop');
    check(await ev("document.querySelectorAll('#nowStrip .ns').length") === 11, 'eleven live cells');
    /* 逐时数据从当前小时往后数，跨零点那天可能只有 23 行，不能写死 24 */
    const proRows = await ev("document.querySelectorAll('#proTable tbody tr').length");
    check(proRows >= 1 && proRows <= 24, 'hourly rows within one day: ' + proRows);
    check(await ev("[...document.querySelectorAll('#nowStrip .ns span')].some(e=>e.textContent==='露点差')"), 'dew-point gap shown');
    check(await ev("[...document.querySelectorAll('#nowStrip .ns span')].some(e=>e.textContent==='日照')"), 'daylight shown');

    await shotFit('02-charts.png');

    /* ---------- 4 ---------- */
    console.log('\n== 4. day switch + task switch ==');
    const t0 = await ev("document.getElementById('windTitle').textContent");
    await ev("document.querySelectorAll('#weekStrip .wk')[3].click();");
    await sleep(700);
    const t1 = await ev("document.getElementById('windTitle').textContent");
    check(t0 !== t1, 'chart title follows day selection');
    check(await ev("document.querySelectorAll('#weekStrip .wk.sel').length") === 1,
      'exactly one day selected');

    // v5：作业切换合并进决策卡 tab，结论、条带、图表一起换
    const sprayTxt = await ev("document.getElementById('dWord').textContent");
    await ev("document.querySelector('#dTabs [data-task=\"irrigation\"]').click();");
    await sleep(400);
    const irrTxt = await ev("document.getElementById('dWord').textContent");
    check(sprayTxt !== irrTxt, 'task switch changes verdict: ' + irrTxt);
    check(await ev("document.getElementById('wkSub').textContent.indexOf('灌溉') >= 0"),
      'week strip follows task');

    await ev("document.querySelector('#dTabs [data-task=\"harvest\"]').click();");
    await sleep(400);
    const harvTxt = await ev("document.getElementById('dWord').textContent");
    check(/晒/.test(harvTxt), 'harvest verdict shown: ' + harvTxt);

    // 切回打药，避免影响后续截图
    await ev("document.querySelector('#dTabs [data-task=\"spray\"]').click();");
    await sleep(400);

    // 预设城市按钮必须已移除
    check(await ev("!document.getElementById('presetChips')"), 'preset city chips removed');

    // 名称已改为打药窗
    check(/打药窗/.test(await ev("document.querySelector('.brand-name').textContent")), 'brand renamed to 打药窗');
    check(/打药窗/.test(await ev("document.title")), 'document title renamed');

    /* ---------- 5 ---------- */
    console.log('\n== 5. add plot ==');
    await ev("document.getElementById('plotMask').classList.remove('on')");
    await sleep(200);
    const before = await ev("document.querySelectorAll('#plotList .plot').length");
    await ev("document.getElementById('addPlotBtn').click();");
    await sleep(600);
    check(await ev("document.getElementById('plotMask').classList.contains('on')"), 'modal opened');

    // 地图现在常驻在弹窗上半屏，不需要再点「展开」
    await sleep(2500);
    /* 高德 SDK 可能因 key / 网络 / 域名白名单加载失败，产品会降级到
       本地行政区划示意图。两种模式都必须能点选取点，测试要认这个降级态。 */
    let mode = '', mapReady = false;
    for (let i = 0; i < 25; i++) {
      mode = await ev("document.getElementById('mapMode').textContent");
      mapReady = await ev("(function(){return !!(window.__tzMap && typeof window.__tzMap.getCenter==='function') || !!document.getElementById('fallbackSvg');})()");
      if (mapReady && (mode.indexOf('高德') >= 0 || mode.indexOf('示意') >= 0)) break;
      await sleep(500);
    }
    check(mapReady, 'map rendered (AMap or local fallback): ' + mode);
    check(mode.indexOf('地图加载中') < 0, 'map mode label reflects final state: ' + mode);
    check(await ev("document.getElementById('layerRoad').classList.contains('on') && !document.getElementById('layerSat').classList.contains('on')"),
      'map opens on road layer, not satellite');
    check(await ev(`(function(){
      var l = document.querySelector('.map-layers');
      if (getComputedStyle(l).display === 'none') return true; // 本地示意地图没有图层切换
      var r = l.getBoundingClientRect(), s = document.getElementById('mapStage').getBoundingClientRect();
      return (r.top - s.top) < 60 && (s.right - r.right) < 60;
    })()`), 'layer switch sits top-right (or hidden on fallback map)');

    /* 桌面：地图在上、表单在下，抽屉静态（拖拽只在手机生效） */
    check(await ev("!!document.getElementById('plotSheet') && !!document.getElementById('sheetGrab')"),
      'plot sheet + grab handle present');
    check(await ev(`(function(){
      var s = document.getElementById('plotSheet');
      return getComputedStyle(s).position === 'static';
    })()`), 'sheet is static card on desktop (no mobile detents)');
    check(await ev(`(function(){
      var s = document.getElementById('plotSheet');
      return !s.style.getPropertyValue('--sheet-y');
    })()`), 'no --sheet-y offset on desktop');

    check(await ev("window.__tzPickCenter && window.__tzPickCenter()") === true,
      'map pick triggered in either mode');
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

    /* ---------- 5c：手机高德式抽屉（拖拽跟手、吸附、下拉关闭） ---------- */
    console.log('\n== 5c. mobile draggable sheet ==');
    await device(390, 844, true, 2);
    await sleep(300);
    await ev("document.getElementById('addPlotBtn').click();");
    await sleep(1200);
    const sheetY = () => ev(`(function(){var s=document.getElementById('plotSheet');
      return parseFloat(getComputedStyle(s).getPropertyValue('--sheet-y'))||0;})()`);
    const y0 = await sheetY();
    check(y0 > 200 && y0 < 500, 'sheet rests at peek on open (px): ' + Math.round(y0));
    check(await ev("getComputedStyle(document.getElementById('plotSheet')).position === 'absolute'"),
      'sheet is an overlay on mobile');
    check(await ev(`(function(){var m=document.getElementById('mapStage').getBoundingClientRect();
      return m.height > window.innerHeight * 0.8;})()`), 'map fills the screen behind the sheet');

    // 上拉：抽屉跟手上移，吸附到 form（位移变小）
    await ev(`(function(){var g=document.getElementById('sheetGrab');
      function pe(t,y){g.dispatchEvent(new PointerEvent(t,{bubbles:true,clientY:y,clientX:180,pointerId:7}));}
      pe('pointerdown',600); for(var i=1;i<=6;i++) pe('pointermove',600-i*55); pe('pointerup',270);})()`);
    await sleep(420);
    const yForm = await sheetY();
    check(yForm < y0 - 120, 'drag up moves the sheet toward the form detent (px): ' + Math.round(yForm));

    // 下拉到底：关闭弹窗
    await ev(`(function(){var g=document.getElementById('sheetGrab');
      function pe(t,y){g.dispatchEvent(new PointerEvent(t,{bubbles:true,clientY:y,clientX:180,pointerId:8}));}
      pe('pointerdown',120); for(var i=1;i<=8;i++) pe('pointermove',120+i*90); pe('pointerup',840);})()`);
    await sleep(600);
    check(!(await ev("document.getElementById('plotMask').classList.contains('on')")),
      'dragging the sheet far down dismisses the modal');

    await device(1600, 1200, false, 1);
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

    /* v5.2：药已定 → 首答两行结论；展开层再分段折叠，依据原文移到「我的」 */
    const chemFirst = await ev(`(() => {
      const b = [...document.querySelectorAll('#qaLog .msg.bot')].pop();
      const det = b.querySelector('.qa-more');
      return { brief: b.querySelector('.body').getAttribute('data-brief'),
               hasMore: !!det, open: det ? det.open : null,
               subs: det ? det.querySelectorAll('.qa-sub').length : 0,
               l1: b.querySelectorAll('.body .qa-l1').length,
               nums: b.querySelectorAll('.body .qa-num').length };
    })()`);
    check(/^(打药|除草剂)/.test(chemFirst.brief) && /未来 7 天/.test(chemFirst.brief),
      'week question answers with a week window: ' + chemFirst.brief.slice(0, 40));
    check((chemFirst.brief.match(/\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}/g) || []).length >= 1,
      'week brief puts concrete time windows in the first bubble');
    check(chemFirst.l1 && chemFirst.nums >= 2,
      'verdict line is emphasised and numbers are bold: ' + chemFirst.nums);
    check(chemFirst.brief.split('\n').length === 2 && chemFirst.brief.length <= 170,
      'first answer is two short lines: ' + chemFirst.brief.length + ' chars');
    check(chemFirst.hasMore && chemFirst.open === false, 'full analysis collapsed by default');
    check(chemFirst.subs >= 2, 'analysis folds again inside: ' + chemFirst.subs + ' subsections');
    await ev("[...document.querySelectorAll('#qaLog .qa-more')].pop().querySelector('summary').click()");
    await sleep(180);
    const chemDetail = await ev("[...document.querySelectorAll('#qaLog .qa-more-body')].pop().textContent");
    check(/依据 \d+ 份/.test(chemDetail) && /NY\/T 1276/.test(chemDetail), 'expanded analysis cites authoritative files');
    check(!/https?:\/\//.test(chemDetail), 'chat no longer dumps source URLs');
    check(/不推荐药剂/.test(chemDetail), 'expanded analysis states capability boundary');
    check(/原文链接在「我的 → 施药依据库」/.test(chemDetail), 'source list points to Mine page');

    async function sendQA(q) {
      await ev(`(function(){var i=document.getElementById('qaInput');i.value=${JSON.stringify(q)};document.getElementById('qaSend').click();})()`);
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        if (await ev("!document.querySelector('#qaLog .typing')")) break;
      }
      return await ev("[...document.querySelectorAll('#qaLog .msg.bot:not(.typing-wrap)')].pop().querySelector('.body').getAttribute('data-brief')");
    }
    const sw = await sendQA('换成杀虫剂呢？');
    check(/杀虫剂/.test(sw), 'follow-up switches pesticide type: ' + sw.slice(0, 32));
    const dy = await sendQA('那明天呢？');
    check(/明天/.test(dy) && /杀虫剂/.test(dy), 'follow-up keeps type and switches day: ' + dy.slice(0, 32));
    const dw = await sendQA('哪天能打药？');
    check(dw.length > 4 && !/^除草剂 ·/.test(dw), 'date-window question still goes to rule engine');
    const nowAsk = await sendQA('现在能打除草剂吗？');
    check(/除草剂/.test(nowAsk) && /现在/.test(nowAsk), 'now question still answered about now: ' + nowAsk.slice(0, 30));
    const prodAsk = await sendQA('这周哪天能打草甘膦？');
    check(/草甘膦/.test(prodAsk) && /未来 7 天/.test(prodAsk), 'named product answers about the product: ' + prodAsk.slice(0, 34));

    /* 聊天页视觉快照：收起所有展开层，首屏只留结论与推荐追问 */
    await ev("(function(){document.querySelectorAll('#qaLog .qa-more').forEach(function(d){d.open=false});var b=document.querySelector('button[data-view=\"chat\"]');if(b)b.click();})()");
    await sleep(400);
    await shotViewport('06-chat-spray.png');

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
    check(await ev("document.querySelectorAll('#weekStrip .wk').length") === 7, 'seven window slots over file protocol');
    check(pageErrors.length === 0, 'no JS error over file protocol');
    const fpCharts = await ev("document.querySelectorAll('svg.chart').length");
    const fpWindEmpty = await ev("/无逐小时数据/.test(document.getElementById('windChart').textContent)");
    check(fpCharts >= 4 || (fpCharts >= 3 && fpWindEmpty), 'charts render over file protocol');

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
    /* 证据层在手机上默认收起，点开才看，避免首屏堆信息 */
    check(await ev("document.getElementById('basisPanel').open === false"), 'evidence panel collapsed on mobile');
    await ev("document.getElementById('basisPanel').querySelector('summary').click()");
    await sleep(350);
    check(await ev("document.getElementById('basisPanel').open === true"), 'evidence panel opens on tap');
    check(await ev("document.querySelectorAll('#nowStrip .ns').length") === 11, 'eleven live cells on mobile');
    /* 打开后图表必须按真实宽度重画，不能停在收起时的 0 宽度上 */
    check(await ev("(function(){var s=document.querySelector('#windChart svg');return s&&s.getBoundingClientRect().width>200;})()"),
      'charts redrawn at real width after panel opens');
    const mobOverflow = await ev("document.documentElement.scrollWidth - window.innerWidth");
    check(mobOverflow <= 2, 'no overflow with evidence panel open: ' + mobOverflow + 'px');
    await ev("document.getElementById('basisPanel').querySelector('summary').click()");
    await sleep(150);
    await shotFull('05-mobile.png');

    /* ---------- 12 ---------- */
    /* 内容层回归：知识依据、资料来源、作品说明、范围卡、示例问题、
       以及问答的「依据 / 边界 / 纠错」闭环。
       这些是交互智能体选题的评分点，必须有测试兜着，不能只靠肉眼看。 */
    console.log('\n== 12. content layer ==');
    await device(1000, 900, false, 1);
    await send('Page.navigate', { url: PAGE_URL });
    await sleep(1800);
    check(await ev("!!window.TianZhiContent"), 'content.js loaded');
    check(await ev("!!window.TianZhiStandards"), 'standards.js loaded');
    // v4.7 起多了「结露门槛」「日落收工」两行，共 7 条
    check(await ev("document.querySelectorAll('#stdBox .std-row').length") === 7, 'standard card: seven limits');
    check(await ev("document.getElementById('stdBox').textContent.indexOf('露点') >= 0"), 'standard card mentions dew point');
    check(await ev("document.getElementById('stdBox').textContent.indexOf('日落') >= 0"), 'standard card mentions sunset');
    check(await ev("document.querySelectorAll('#stdBox .std-file').length") >= 2, 'standard card: source files listed');
    check(await ev("document.querySelectorAll('#stdBox .std-cov-row').length") === 11, 'standard coverage: 11 cities');
    check(await ev("!document.getElementById('kbBox') && !document.getElementById('srcBox')"), 'long basis blocks removed from home');
    check(await ev("!document.getElementById('projBox')"), 'competition brief removed from app');
    check(await ev("document.querySelectorAll('#qaChips .chip-btn').length") >= 6, 'chat presets rendered');
    check(await ev("document.getElementById('jqFarm').textContent.length") > 12, 'solar-term farming tip');
    check(await ev("!document.querySelector('.pos-strip')"), 'marketing strip removed from home');
    check(await ev("!!document.querySelector('.chat-line')"), 'chat shows one-line boundary');

    /* 依据弹层：口径与来源收到一个入口里，首页不再平铺 */
    await ev("document.getElementById('basisOpen').click();");
    await sleep(250);
    check(await ev("document.getElementById('basisMask').classList.contains('on')"), 'basis sheet opens');
    check(await ev("document.querySelectorAll('#basisRules .basis-rule').length") === 4, 'basis sheet: four core rules');
    check(await ev("document.querySelectorAll('#basisSources > div').length") === 4, 'basis sheet: four source groups');
    check(await ev("/\\d+ 条/.test(document.getElementById('kbStat').textContent)"), 'local KB count shown');
    await ev("(function(){var i=document.getElementById('kbSearch');i.value='霜降';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await sleep(200);
    check(await ev("document.querySelectorAll('#kbHits .kb-hit').length") >= 1, 'local KB search returns hits');
    await ev("(function(){var i=document.getElementById('kbSearch');i.value='逆温';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await sleep(200);
    check(await ev("document.querySelectorAll('#kbHits .kb-hit').length") >= 1, 'local KB: spraying-weather sources indexed');
    await ev("document.getElementById('basisClose').click();");
    await sleep(150);

    await waitData();
    /* 本地若配了大模型，refine / refuse 是异步的，会让「最后一条消息」的断言
       抢在回答前面跑。内容层测的是规则与文案，先切回纯规则引擎更可靠。 */
    await ev("(function(){var b=document.getElementById('aiToggle');if(b&&b.textContent.trim()==='开')b.click();return b?b.textContent:'';})()");
    await ev("document.querySelectorAll('#qaChips .chip-btn')[0].click();");
    let noteReady = false;
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      if (await ev("!!document.querySelector('#qaLog .msg.bot .an-line')")) { noteReady = true; break; }
    }
    check(noteReady, 'answer has basis / boundary note');
    check(await ev("document.querySelectorAll('#qaLog .msg.bot .sug-row .sug').length") >= 2, 'follow-up suggestions shown');
    await ev("document.getElementById('qaInput').value='明天和后天哪天更好？';document.getElementById('qaSend').click();");
    await sleep(450);
    check(await ev("[...document.querySelectorAll('#qaLog .msg.bot')].some(function(x){return /优先选|两天都不合适/.test(x.textContent)})"), 'day comparison answered');

    /* v4.7：日出日落问答——数据来自逐日 sunrise/sunset，不是编的 */
    await ev("document.getElementById('qaInput').value='日出日落几点？';document.getElementById('qaSend').click();");
    await sleep(500);
    check(await ev("[...document.querySelectorAll('#qaLog .msg.bot')].some(function(x){return x.textContent.indexOf('日落')>=0 && /[0-9][0-9]:[0-9][0-9]/.test(x.textContent)})"), 'sunrise/sunset answered with clock times');
    await ev("document.getElementById('qaInput').value='为什么这么判断？';document.getElementById('qaSend').click();");
    await sleep(350);
    check(await ev("[...document.querySelectorAll('#qaLog .msg.bot')].some(function(x){return x.textContent.indexOf('我把')>=0})"), 'method question answered');
    await ev("document.getElementById('qaInput').value='我这里按什么标准打药？';document.getElementById('qaSend').click();");
    await sleep(500);
    check(await ev("[...document.querySelectorAll('#qaLog .msg.bot')].some(function(x){return x.textContent.indexOf('查证日期')>=0&&x.textContent.indexOf('3.4')>=0})"), 'standard question answered with citation');
    await ev("document.getElementById('qaInput').value='这个结论准不准？';document.getElementById('qaSend').click();");
    await sleep(350);
    check(await ev("[...document.querySelectorAll('#qaLog .msg.bot')].some(function(x){return x.textContent.indexOf('老实说')>=0})"), 'reliability question answered');
    await ev("document.getElementById('qaInput').value='我家小麦该打什么药？';document.getElementById('qaSend').click();");
    await sleep(350);
    check(await ev("[...document.querySelectorAll('#qaLog .msg.bot')].some(function(x){return /能力范围|处理范围|不在我的/.test(x.textContent)})"), 'out-of-scope refused honestly');
    await ev("document.querySelector('.an-line button[data-act=fix]').click();");
    await sleep(150);
    check(await ev("!!document.querySelector('.an-form')"), 'correction form opens');
    await ev("document.querySelector('.an-form textarea').value='test feedback';document.querySelector('.an-form>div button').click();");
    await sleep(200);
    check(await ev("JSON.parse(localStorage.getItem('tianzhi.corrections.v1')||'[]').length") >= 1, 'correction stored locally');
    check(pageErrors.length === 0, 'no JS error in content layer');

    /* 「我的」页的作品说明含表格与 13 个折叠章节，是最容易把手机撑宽的一块 */
    await ev("document.querySelector('[data-view=mine]').click();");
    await device(390, 844, true, 2);
    await sleep(600);
    const mineOverflow = await ev("document.documentElement.scrollWidth - window.innerWidth");
    check(mineOverflow <= 2, 'project brief no overflow on mobile: ' + mineOverflow + 'px');
    const lib = JSON.parse(await ev(`JSON.stringify({
      src: document.querySelectorAll('#chemSrcList .chem-src').length,
      links: document.querySelectorAll('#chemSrcList a').length,
      prod: document.querySelectorAll('#chemProdList .chem-prod').length
    })`));
    check(lib.src >= 10 && lib.links >= 10, 'mine page lists sources with links: ' + lib.src);
    check(lib.prod >= 10, 'mine page lists pesticide profiles: ' + lib.prod);

    const stdFold = JSON.parse(await ev(`(function(){
      var d = [...document.querySelectorAll('#stdBox details')].find(function(x){
        var s = x.querySelector('summary');
        return s && s.textContent.indexOf('依据文件清单') >= 0;
      });
      var b = document.querySelector('#stdBox .std-file-top b');
      return JSON.stringify({
        has: !!d, open: d ? d.open : null,
        files: d ? d.querySelectorAll('.std-file').length : 0,
        color: b ? getComputedStyle(b).color : ''
      });
    })()`));
    check(stdFold.has && stdFold.open === false, 'standards source list folded by default');
    check(stdFold.files >= 3, 'folded list renders the city applicable files: ' + stdFold.files);
    check(stdFold.color !== 'rgb(0, 0, 238)', 'source titles use brand colour, not default link blue: ' + stdFold.color);
    check(await ev("(function(){var s=getComputedStyle(document.documentElement);return !!s.getPropertyValue('--brand-d').trim() && !!s.getPropertyValue('--shadow-sm').trim();})()"),
      'design tokens brand-d/shadow-sm are defined');

    /* ---------- 13 ---------- */
    /* v5 的关键交互：条带选日、任务切换、作业留痕、依据入口。
       这些是新架构的主链路，必须有断言兜着，不能只靠肉眼看截图。 */
    console.log('\n== 13. v5 decision interactions ==');
    await device(1440, 1000, false, 1);
    await send('Page.navigate', { url: PAGE_URL });
    await sleep(1800);
    await waitData();
    check(await ev("document.getElementById('basisPanel').open === true"), 'evidence panel open on desktop');
    check(await ev("document.querySelectorAll('#dTabs button').length") === 3, 'three task tabs');

    const wd0 = await ev("document.querySelector('#weekDay .wd-h b').textContent");
    const wt0 = await ev("document.getElementById('windTitle').textContent");
    /* 默认选中日就是「下一次机会」那天，必须点一个不同的日子才有变化可断言 */
    const selIdx = await ev("[...document.querySelectorAll('#weekStrip .wk')].findIndex(function(b){return b.classList.contains('sel')})");
    const pickIdx = selIdx === 4 ? 5 : 4;
    await ev("document.querySelectorAll('#weekStrip .wk')[" + pickIdx + "].click();");
    await sleep(350);
    const wd1 = await ev("document.querySelector('#weekDay .wd-h b').textContent");
    const wt1 = await ev("document.getElementById('windTitle').textContent");
    check(wd0 !== wd1, 'day detail follows strip: ' + wd0 + ' -> ' + wd1);
    check(wt0 !== wt1, 'chart follows strip: ' + wt0 + ' -> ' + wt1);

    /* 回归：点「今天」不能被自动跳到下一个窗口日 */
    await ev("document.querySelectorAll('#weekStrip .wk')[0].click();");
    await sleep(320);
    const selDate = await ev("(function(){var b=document.querySelector('#weekStrip .wk.sel');return b?b.getAttribute('data-date'):'';})()");
    const firstDate = await ev("document.querySelectorAll('#weekStrip .wk')[0].getAttribute('data-date')");
    check(selDate === firstDate, 'clicking today keeps today selected: ' + selDate);
    const wkFont = await ev("parseFloat(getComputedStyle(document.querySelector('#weekStrip .wk-dow b')).fontSize)");
    check(wkFont >= 12.5, 'day labels are readable on mobile/desktop: ' + wkFont + 'px');

    await ev("localStorage.removeItem('tz_logs')");
    await ev("document.getElementById('dLogBtn').click();");
    await sleep(220);
    check(await ev("JSON.parse(localStorage.getItem('tz_logs')||'[]').length") >= 1,
      'work log written to this device');
    check(await ev("document.getElementById('dLogLine').textContent.indexOf('上次打药') >= 0"),
      'decision card shows last-work history');
    await ev("document.getElementById('dLogUndo').click();");
    await sleep(180);
    check(await ev("document.getElementById('dLogLine').textContent.indexOf('还没有记录') >= 0"),
      'work log can be undone');

    await ev("document.getElementById('basisPanel').open=false;document.getElementById('dBasisBtn').click();");
    await sleep(350);
    check(await ev("document.getElementById('basisPanel').open === true"),
      '"why this time" opens the evidence layer');
    check(await ev("document.querySelectorAll('#nowStrip .ns').length") === 11,
      'evidence layer shows live values after opening');
    check(pageErrors.length === 0, 'no JS error in v5 interactions');

    /* 断网错误态：v5 以前这里会因为写已删除的 #heroIn 直接抛错，
       连「重新获取」都出不来。用 CDP 拦掉天气域名做一次真实回归。 */
    console.log('\n== 14. offline error state ==');
    pageErrors.length = 0; consoleErrors.length = 0;
    try {
      await send('Network.enable');
      await send('Network.setBlockedURLs', {
        urls: ['*open-meteo.com*', '*qweather*', '*api.agnes-ai.cn*']
      });
      await send('Page.navigate', { url: PAGE_URL });
      await sleep(3500);
      check(await ev("!!document.getElementById('retryBtn')"), 'error state offers retry button');
      check(await ev("!!document.querySelector('#alerts .err-art')"), 'error state carries offline illustration');
      check(await ev("document.getElementById('dWord').textContent.indexOf('等待') >= 0"),
        'decision skeleton survives network failure');
      check(pageErrors.length === 0, 'no uncaught exception in error state' +
        (pageErrors.length ? ': ' + pageErrors[0].slice(0, 150) : ''));
      await send('Network.setBlockedURLs', { urls: [] });
    } catch (e) {
      console.log('  SKIP offline check: ' + e.message);
    }

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
