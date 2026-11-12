/**
 * test-offline.mjs — 测试 file:// 双击打开场景
 * 模拟：把网页文件发给别人，别人双击 index.html
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 9260;
// 优先用解压出来的全新副本（模拟别人收到压缩包），否则用临时目录
let TMP;
const freshFile = path.join(process.env.TEMP, 'tz_fresh_path.txt');
if (fs.existsSync(freshFile)) {
  TMP = path.join(fs.readFileSync(freshFile, 'utf8').trim(), '知时智农');
  if (!fs.existsSync(TMP)) {
    TMP = path.join(path.dirname(TMP), fs.readdirSync(path.dirname(TMP))[0]);
  }
} else {
  TMP = fs.readFileSync(path.join(process.env.TEMP, 'tz_test_path.txt'), 'utf8').trim();
}
const FILE_URL = 'file:///' + TMP.replace(/\\/g, '/') + '/web/index.html';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(process.env.TEMP, 'oft' + Date.now()),
  '--window-size=1600,1200', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const logs = [];
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
  if (r.exceptionDetails) {
    return 'EXC: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '').slice(0, 160);
  }
  return r.result ? r.result.value : undefined;
}

let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

(async () => {
  try {
    console.log('=== file:// 离线双击打开测试 ===');
    console.log('URL: ' + FILE_URL + '\n');

    ws = new WebSocket(await target());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled') {
        const t = (m.params.args || []).map(a => a.value || a.description || '').join(' ');
        logs.push(m.params.type + ': ' + t);
        if (m.params.type === 'error') errors.push(t);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const ex = m.params.exceptionDetails;
        errors.push('UNCAUGHT: ' + (ex.exception && ex.exception.description || ex.text));
      }
      if (m.method === 'Log.entryAdded') {
        const en = m.params.entry;
        if (en.level === 'error') {
          errors.push('LOG: ' + en.text + (en.url ? ' @' + en.url.slice(0, 90) : ''));
        }
      }
    };
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: FILE_URL });
    await sleep(4000);

    /* ---- 1. 脚本是否加载 ---- */
    console.log('\n== 1. 脚本加载 ==');
    check(await ev("typeof window.TianZhi === 'object'"), 'logic.js loaded (window.TianZhi)');
    check(await ev("typeof window.TianZhiWeather === 'object'"), 'weather.js loaded (window.TianZhiWeather)');
    check(await ev("typeof window.TianZhiLLM === 'object'"), 'llm.js loaded (window.TianZhiLLM)');
    check(await ev("!!window.HEBEI_GEO || typeof window.HEBEI_GEO === 'object'"), 'hebei-geo.js loaded');
    check(await ev("!!window.TIANZHI_CONFIG"), 'config.js loaded (window.TIANZHI_CONFIG)');

    /* ---- 2. 界面是否渲染 ---- */
    console.log('\n== 2. 界面渲染 ==');
    check((await ev("document.querySelector('.brand-name').textContent")) === '知时智农', 'brand rendered');
    check((await ev("document.querySelectorAll('#days .day').length")) === 7, 'seven day cards');
    check((await ev("document.querySelectorAll('#cards .kpi-item').length")) === 3, 'three judgement cards');

    /* ---- 3. 天气是否取到（关键：跨域） ---- */
    console.log('\n== 3. 实时数据（file:// 下的跨域请求） ==');
    const status = await ev("document.getElementById('statusText').textContent");
    console.log('   status text: ' + JSON.stringify(status));
    check(/实时数据/.test(status || ''), 'weather status shows real-time data');

    let dayStates = await ev("Array.from(document.querySelectorAll('#days .day .day-state')).map(function(e){return e.textContent}).join('|')");
    console.log('   day verdicts: ' + dayStates);
    check(dayStates && dayStates.indexOf('None') < 0 && dayStates.length > 3, 'verdicts computed with real data');

    /* ---- 4. 图表 ---- */
    console.log('\n== 4. 图表 ==');
    check(await ev("!!document.querySelector('#windChart svg')"), 'wind chart');
    check(await ev("!!document.querySelector('#heatChart svg')"), 'heatmap chart');
    check(await ev("!!document.querySelector('#tempChart svg')"), 'temp chart');
    check(await ev("!!document.querySelector('#donutChart svg')"), 'donut chart');

    /* ---- 5. localStorage 在 file:// 下是否可用 ---- */
    console.log('\n== 5. 本地存储（file:// 下行为） ==');
    const lsTest = await ev(`(function(){
      try {
        localStorage.setItem('__tz_probe','1');
        var v = localStorage.getItem('__tz_probe');
        localStorage.removeItem('__tz_probe');
        return v === '1' ? 'ok' : 'read-fail';
      } catch(e) { return 'blocked: ' + e.name; }
    })()`);
    console.log('   localStorage: ' + lsTest);
    check(lsTest === 'ok', 'localStorage usable on file://');

    /* ---- 6. 地图（高德需要 https 域名白名单） ---- */
    console.log('\n== 6. 高德地图 ==');
    const mapLoaded = await ev("typeof AMap !== 'undefined'");
    console.log('   AMap object: ' + mapLoaded);
    check(mapLoaded === true, 'AMap SDK loads on file://');

    /* ---- 7. 错误汇总 ---- */
    console.log('\n== 7. 错误汇总 ==');
    const realErrors = errors.filter(e =>
      !/favicon/i.test(e) &&
      !/ERR_FILE_NOT_FOUND.*favicon/i.test(e)
    );
    if (realErrors.length) {
      console.log('   发现 ' + realErrors.length + ' 条错误：');
      realErrors.slice(0, 12).forEach(e => console.log('     - ' + e.slice(0, 180)));
    } else {
      console.log('   无错误');
    }
    check(realErrors.length === 0, 'no runtime errors on file://');

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
