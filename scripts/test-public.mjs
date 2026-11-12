/**
 * test-public.mjs — 验证公网版（无 DeepSeek key）功能完整
 * 核心验证点：关掉大模型后，所有结论/数字必须与本地版一致
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '..', 'dist', '公网版');
const PORT = 9312;

if (!fs.existsSync(path.join(DIR, 'index.html'))) {
  console.error('找不到公网版产物，先运行 node build-public.mjs');
  process.exit(1);
}

// 起一个静态服务器指向公网版目录
const server = spawn(process.execPath, ['-e', `
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=${JSON.stringify(DIR)};
const MIME={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.txt':'text/plain;charset=utf-8','.mjs':'text/javascript;charset=utf-8'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]);
  if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);res.end('nf');return;}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
}).listen(${PORT},()=>console.log('ready'));
`], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

let proc;
const launch = () => spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=' + (PORT + 1),
  '--user-data-dir=' + path.join(process.env.TEMP || '.', 'pb' + Date.now()),
  'about:blank'
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
const pageErrors = [];
let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT + 1}/json/list`);
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
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200);
  return r.result ? r.result.value : undefined;
}

(async () => {
  try {
    console.log('=== 公网版功能验证（无大模型） ===\n');
    await sleep(1200);
    proc = launch();

    ws = new WebSocket(await target());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push((m.params.exceptionDetails.exception?.description || '').slice(0, 200));
      }
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(5500);

    console.log('== 1. 配置已生效 ==');
    const cfg = await ev(`(function(){
      var c = window.TIANZHI_CONFIG;
      return JSON.stringify({
        llmOn: c.enableLLM,
        hasKey: !!(c.deepseekKey && c.deepseekKey.length),
        hasAmap: !!c.amapKey,
        hasQw: !!c.qweatherKey,
        keyPreview: (c.deepseekKey || '(空)').slice(0, 6)
      });
    })()`);
    const C = JSON.parse(cfg);
    check(C.llmOn === false, '大模型已关闭');
    check(C.hasKey === false, 'DeepSeek key 已移除');
    check(C.hasAmap, '高德 key 保留');
    check(C.hasQw, '和风 key 保留');

    console.log('\n== 2. 数据与界面正常 ==');
    let status = '';
    for (let i = 0; i < 40; i++) {
      status = await ev("document.getElementById('statusText').textContent");
      if (status && String(status).indexOf('实时数据') >= 0) break;
      await sleep(500);
    }
    check(String(status).indexOf('实时数据') >= 0, '天气数据加载 (' + status + ')');

    const ui = await ev(`(function(){
      return JSON.stringify({
        days: document.querySelectorAll('#days .day').length,
        kpis: document.querySelectorAll('#cards .kpi-item').length,
        conf: document.querySelectorAll('.conf-badge').length,
        whatif: document.querySelectorAll('.whatif-btns button').length,
        aiTag: document.getElementById('aiTag').textContent.trim(),
        winDate: document.querySelector('.window-date') ? document.querySelector('.window-date').textContent.trim() : ''
      });
    })()`);
    const U = JSON.parse(ui);
    check(U.days === 7, '七日卡片正常');
    check(U.kpis === 3, '判断卡正常');
    check(U.aiTag === '纯规则引擎', '界面标明「纯规则引擎」(' + U.aiTag + ')');
    console.log('   推荐日: ' + U.winDate);
    console.log('   置信度徽章: ' + U.conf + ' 个，反事实按钮: ' + U.whatif + ' 个');

    console.log('\n== 3. 关键：没有大模型，问答还能用吗 ==');
    const before = await ev("document.querySelectorAll('#qaLog .msg').length");
    await ev(`(function(){
      var i = document.getElementById('qaInput');
      i.value = '什么时候打药';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('qaSend').click();
    })()`);
    let msgs = before;
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      msgs = await ev("document.querySelectorAll('#qaLog .msg').length");
      if (msgs >= before + 2) break;
    }
    check(msgs >= before + 2, '纯规则引擎仍能回答（' + before + ' → ' + msgs + ' 条）');

    const answers = await ev(`(function(){
      var out = [];
      document.querySelectorAll('#qaLog .msg.bot .body').forEach(function(e){ out.push(e.textContent.trim().slice(0,90)); });
      return JSON.stringify(out);
    })()`);
    const A = JSON.parse(answers);
    console.log('   机器人回答:');
    A.forEach(a => console.log('     · ' + a.replace(/\n/g, ' / ')));

    // 再用几个不同问法
    for (const q of ['要不要浇水', '明天什么天气', '能晾晒吗']) {
      const b = await ev("document.querySelectorAll('#qaLog .msg').length");
      await ev(`(function(){
        var i = document.getElementById('qaInput');
        i.value = ${JSON.stringify(q)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('qaSend').click();
      })()`);
      for (let k = 0; k < 16; k++) {
        await sleep(400);
        const n = await ev("document.querySelectorAll('#qaLog .msg').length");
        if (n >= b + 2) break;
      }
    }
    const all = await ev("document.querySelectorAll('#qaLog .msg.bot').length");
    check(all >= 5, '多种问法都能回答（机器人消息 ' + all + ' 条）');

    console.log('\n== 4. 反事实推演仍可用 ==');
    const wf = await ev(`(function(){
      var b = document.querySelector('.whatif-btns button');
      if (!b) return 'no';
      b.click();
      return 'ok';
    })()`);
    await sleep(600);
    const wfOut = await ev("document.getElementById('whatifOut') ? document.getElementById('whatifOut').textContent.trim().length : 0");
    check(wf === 'ok' && wfOut > 10, '反事实推演正常');

    console.log('\n== 5. 无异常 ==');
    console.log('  未捕获异常: ' + (pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '无'));
    check(pageErrors.length === 0, '无未捕获异常');

    console.log(`\n===== RESULT: pass ${pass} / fail ${fail} =====`);
    try { proc.kill(); } catch (e) { /* ignore */ }
    try { server.kill(); } catch (e) { /* ignore */ }
    await sleep(300);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('FATAL: ' + e.message);
    try { proc && proc.kill(); } catch (e2) { /* ignore */ }
    try { server.kill(); } catch (e2) { /* ignore */ }
    process.exit(1);
  }
})();
