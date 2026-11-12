/**
 * test-single.mjs — 在浏览器里真实加载单文件版
 * -------------------------------------------------------------
 * 静态检查只能证明字符串拼对了；真正的判据是：
 * 用 file:// 打开单个 html，看数据能不能算出来、界面能不能渲染。
 * 这正是评委/同学拿到文件后的真实场景。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '..', 'dist', '单文件版', '知时智农.html');
const PORT = 9310;

if (!fs.existsSync(FILE)) {
  console.error('找不到单文件产物，先运行 node build-single.mjs');
  process.exit(1);
}

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(process.env.TEMP || '.', 'sg' + Date.now()),
  'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
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
  throw new Error('cdp');
}
function send(m, p) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  return new Promise(r => pending.set(i, r));
}
async function ev(x) {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 250);
  }
  return r.result ? r.result.value : undefined;
}

const fileUrl = 'file:///' + FILE.replace(/\\/g, '/');

(async () => {
  try {
    console.log('=== 单文件版真实加载测试 ===');
    console.log('  文件: ' + FILE);
    console.log('  大小: ' + (fs.statSync(FILE).size / 1024).toFixed(1) + ' KB');
    console.log('  URL : ' + fileUrl + '\n');

    ws = new WebSocket(await target());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 150));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push((m.params.exceptionDetails.exception?.description || '').slice(0, 200));
      }
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: fileUrl });
    await sleep(5000);

    console.log('== 1. 各模块是否就位 ==');
    const mods = await ev(`(function(){
      return JSON.stringify({
        logic: typeof window.TianZhi,
        ens: typeof window.TianZhiEnsemble,
        weather: typeof window.TianZhiWeather,
        llm: typeof window.TianZhiLLM,
        cfg: typeof window.TIANZHI_CONFIG
      });
    })()`);
    const M = JSON.parse(mods);
    check(M.logic === 'object', 'TianZhi 就位 (' + M.logic + ')');
    check(M.ens === 'object', 'TianZhiEnsemble 就位 (' + M.ens + ')');
    check(M.weather === 'object', 'TianZhiWeather 就位 (' + M.weather + ')');
    check(M.llm === 'object', 'TianZhiLLM 就位 (' + M.llm + ')');
    check(M.cfg === 'object', 'TIANZHI_CONFIG 就位 (' + M.cfg + ')');

    console.log('\n== 2. 数据是否真的取到 ==');
    let status = '';
    for (let i = 0; i < 40; i++) {
      status = await ev("document.getElementById('statusText').textContent");
      if (status && String(status).indexOf('实时数据') >= 0) break;
      await sleep(500);
    }
    check(String(status).indexOf('实时数据') >= 0, '天气数据加载成功 (' + status + ')');

    console.log('\n== 3. 界面渲染 ==');
    const ui = await ev(`(function(){
      return JSON.stringify({
        hero: document.querySelectorAll('#heroIn .window-date').length,
        days: document.querySelectorAll('#days .day').length,
        kpis: document.querySelectorAll('#cards .kpi-item').length,
        charts: document.querySelectorAll('.chart-scroll svg').length,
        conf: document.querySelectorAll('.conf-badge').length,
        whatif: document.querySelectorAll('.whatif-btns button').length
      });
    })()`);
    const U = JSON.parse(ui);
    check(U.hero === 1, '窗口大卡渲染');
    check(U.days === 7, '七日卡片 7 个 (实际 ' + U.days + ')');
    check(U.kpis === 3, '判断卡 3 张 (实际 ' + U.kpis + ')');
    check(U.charts >= 4, '图表 ' + U.charts + ' 个');
    check(U.conf >= 1, '置信度徽章 (实际 ' + U.conf + ')');
    check(U.whatif >= 4, '反事实按钮 (实际 ' + U.whatif + ')');

    console.log('\n== 4. 交互功能 ==');
    // 切换作业类型
    await ev("document.querySelector('.task-btn[data-task=\"irrigation\"]').click();");
    await sleep(500);
    const irr = await ev("document.querySelector('#days .day-state').textContent.trim()");
    check(/灌溉/.test(irr), '切换到灌溉生效 (' + irr + ')');
    await ev("document.querySelector('.task-btn[data-task=\"spray\"]').click();");
    await sleep(400);

    // 点反事实按钮
    const wf = await ev(`(function(){
      var b = document.querySelector('.whatif-btns button.flips') || document.querySelector('.whatif-btns button');
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()`);
    await sleep(600);
    const wfOut = await ev("document.getElementById('whatifOut') ? document.getElementById('whatifOut').textContent.trim() : ''");
    check(wf === 'ok' && wfOut.length > 10, '反事实推演可运行');

    // 问答：真实元素是 #qaInput（input）和 #qaSend（button）
    const before = await ev("document.querySelectorAll('#qaLog .msg').length");
    await ev(`(function(){
      var i = document.getElementById('qaInput');
      i.value = '什么时候打药好';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('qaSend').click();
    })()`);
    // 等回复：本地规则引擎是同步的，但可能要等 LLM 或打字动画
    let msgs = before;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      msgs = await ev("document.querySelectorAll('#qaLog .msg').length");
      if (msgs >= before + 2) break;
    }
    check(msgs >= before + 2, '问答产生回复（' + before + ' → ' + msgs + ' 条消息）');
    const reply = await ev(`(function(){
      var all = document.querySelectorAll('#qaLog .msg.bot .body');
      return all.length ? all[all.length-1].textContent.trim().slice(0,100) : '';
    })()`);
    console.log('   回复内容: ' + JSON.stringify(reply));

    console.log('\n== 5. 离线能力 ==');
    const offline = await ev(`(function(){
      return JSON.stringify({
        geo: typeof window.HEBEI_GEOJSON !== 'undefined' || typeof window.HebeiGeo !== 'undefined' ||
             !!document.querySelector('canvas') || true,
        storage: (function(){ try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return true; } catch(e){ return false; } })()
      });
    })()`);
    const O = JSON.parse(offline);
    check(O.storage, 'file:// 下 localStorage 可用');

    console.log('\n== 6. 错误情况 ==');
    console.log('  console.error: ' + (consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '无'));
    console.log('  未捕获异常  : ' + (pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '无'));
    check(pageErrors.length === 0, '无未捕获异常');
    // 网络类错误（如某个接口偶发失败）不算致命
    const fatalConsole = consoleErrors.filter(e => !/net::|Failed to fetch|403|Deprecated|404/i.test(e));
    check(fatalConsole.length === 0, '无致命控制台错误');

    console.log('\n== 7. 手机尺寸下也正常 ==');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844
    });
    await sleep(1200);
    const mobileOk = await ev(`(function(){
      var before = window.scrollX;
      window.scrollTo(9999, 0);
      var after = window.scrollX;
      window.scrollTo(before, 0);
      return JSON.stringify({
        canScrollX: after > 0,
        heroW: document.querySelector('#heroIn') ? Math.round(document.querySelector('#heroIn').getBoundingClientRect().width) : 0,
        menu: !!document.getElementById('menuBtn'),
        menuVisible: (function(){
          var b = document.getElementById('menuBtn');
          if (!b) return false;
          var r = b.getBoundingClientRect();
          return r.width > 0;
        })()
      });
    })()`);
    const MB = JSON.parse(mobileOk);
    check(!MB.canScrollX, '手机尺寸无横向滚动');
    check(MB.heroW > 300 && MB.heroW <= 390, '窗口卡宽度适配 (' + MB.heroW + 'px)');
    check(MB.menuVisible, '手机端汉堡菜单显示');

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
