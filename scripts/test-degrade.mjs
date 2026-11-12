/**
 * test-degrade.mjs — 断网 / 接口失败时的降级表现
 * 用 CDP 拦截请求，模拟三种故障场景
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 9272;
const freshDir = fs.readFileSync(path.join(process.env.TEMP, 'tz_fresh_path.txt'), 'utf8').trim();
const APP = path.join(freshDir, '知时智农');
const ROOT = fs.existsSync(APP) ? APP : path.join(freshDir, fs.readdirSync(freshDir)[0]);
const FILE_URL = 'file:///' + path.join(ROOT, 'web', 'index.html').replace(/\\/g, '/');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runScenario(name, blockPattern, expectText) {
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(process.env.TEMP || '.', 'dg' + Date.now()),
    '--window-size=1600,1000', 'about:blank'
  ], { stdio: 'ignore' });

  let ws, id = 0;
  const pending = new Map();
  const errors = [];

  try {
    let targetUrl;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        const l = await r.json();
        const p = l.find(t => t.type === 'page');
        if (p) { targetUrl = p.webSocketDebuggerUrl; break; }
      } catch (e) { /* retry */ }
      await sleep(200);
    }
    ws = new WebSocket(targetUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push('UNCAUGHT: ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 100));
      }
    };
    const send = (m, p) => {
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
      return new Promise(r => pending.set(i, r));
    };
    const ev = async x => {
      const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return 'EXC';
      return r.result ? r.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');

    // Fetch 域拦截（比 Network 域可靠，能拦 fetch/XHR 且可异步决策）
    await send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }]
    });
    let blockedCount = 0;
    ws.addEventListener('message', async e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Fetch.requestPaused') {
        const url = m.params.request.url;
        if (blockPattern.test(url)) {
          blockedCount++;
          try {
            await send('Fetch.failRequest', {
              requestId: m.params.requestId,
              errorReason: 'InternetDisconnected'
            });
          } catch (err) { /* ignore */ }
        } else {
          try {
            await send('Fetch.continueRequest', { requestId: m.params.requestId });
          } catch (err) { /* ignore */ }
        }
      }
    });

    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: FILE_URL });
    await sleep(9000);

    const status = await ev("document.getElementById('statusText').textContent");
    const daysCount = await ev("document.querySelectorAll('#days .day').length");
    const hasErrBox = await ev("!!document.querySelector('.error-box, #errorBox')");
    const bodyHasUndef = await ev("document.body.innerText.indexOf('undefined') >= 0");
    const errText = await ev(`
      (function(){
        var e = document.querySelector('.error-box, #errorBox, .err');
        return e ? e.textContent.slice(0,120) : '';
      })()`);
    // 断网时要检查：是否有清晰的引导而不是白屏
    const hasGuide = await ev(`(function(){
      var t = document.body.innerText;
      return t.indexOf('需要联网') >= 0
          || t.indexOf('检查电脑是否连上网络') >= 0
          || t.indexOf('重新获取') >= 0;
    })()`);
    const guideText = await ev(`(function(){
      var e = document.querySelector('.err-help');
      return e ? e.innerText.replace(/\\n+/g,' / ').slice(0,140) : '';
    })()`);

    const isTotalFailure = /全部/.test(name);

    console.log('--- ' + name + ' ---');
    console.log('  被拦截请求数: ' + blockedCount);
    console.log('  状态文字: ' + JSON.stringify(status));
    console.log('  七日卡片: ' + daysCount);
    if (isTotalFailure) {
      console.log('  引导文案: ' + JSON.stringify(guideText));
    }
    console.log('  含 undefined: ' + bodyHasUndef);
    if (errors.length) console.log('  未捕获异常: ' + errors.slice(0, 3).join(' | '));
    else console.log('  未捕获异常: 无');

    let ok;
    if (isTotalFailure) {
      // 断网是预期内的，要求：不崩溃 + 有清晰引导
      ok = !bodyHasUndef && errors.length === 0 && hasGuide;
      console.log('  结论: ' + (ok ? 'PASS 优雅降级（有引导，未崩溃）' : 'FAIL 引导缺失或崩溃'));
    } else {
      // 单个源失败：主流程必须不受影响
      ok = daysCount === 7 && !bodyHasUndef && errors.length === 0;
      console.log('  结论: ' + (ok ? 'PASS 页面未崩溃' : 'FAIL 有问题'));
    }
    return ok;
  } finally {
    try { proc.kill(); } catch (e) { /* ignore */ }
    await sleep(600);
  }
}

(async () => {
  let pass = 0, fail = 0;

  const scenarios = [
    ['全部气象接口断网', /api\.open-meteo\.com|qweatherapi\.com/],
    ['仅 Open-Meteo 失败', /api\.open-meteo\.com/],
    ['仅和风天气失败', /qweatherapi\.com/],
    ['高德地图 + 大模型失败', /webapi\.amap\.com|api\.deepseek\.com/]
  ];

  for (const [name, pat] of scenarios) {
    if (await runScenario(name, pat)) pass++; else fail++;
    console.log('');
  }

  console.log(`===== 降级测试: pass ${pass} / fail ${fail} =====`);
  process.exit(fail ? 1 : 0);
})();
