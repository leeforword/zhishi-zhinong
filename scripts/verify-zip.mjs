/**
 * verify-zip.mjs — 最终验收：解压压缩包，用解压后的副本做真实测试
 * -------------------------------------------------------------
 * 这一步不能省。之前踩过一个坑：源目录测试全过，
 * 但打包时漏了一个文件，别人拿到就崩。
 * 所以必须脱离源码目录，只用 zip 里的东西验证。
 */
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ZIP = path.join(ROOT, 'dist', '知时智农.zip');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

if (!fs.existsSync(ZIP)) {
  console.error('找不到压缩包，先运行 node package.mjs');
  process.exit(1);
}

/* ---- 解压到临时目录（完全脱离源码） ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-verify-'));
console.log('=== 解压到临时目录 ===');
console.log('  ' + tmp + '\n');

execSync(
  `powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; ` +
  `Expand-Archive -Path '${ZIP}' -DestinationPath '${tmp}' -Force"`,
  { stdio: 'pipe' }
);

const APP = path.join(tmp, '知时智农');

/* ---- 1. 结构检查 ---- */
console.log('== 1. 解压后结构 ==');
const structure = [
  '使用说明.txt',
  'start.bat',
  '知时智农-单文件版.html',
  'web/index.html',
  'web/config.js',
  'web/logic.js',
  'web/ensemble.js',
  'web/weather.js',
  'web/hebei-geo.js',
  'web/llm.js',
  'web/app.js',
  'web/server.mjs',
  'web/qr.mjs'
];
for (const f of structure) {
  const p = path.join(APP, f);
  check(fs.existsSync(p), f);
}

console.log('\n== 2. 公网版存在且无 Key ==');
const pub = path.join(APP, '公网版');
check(fs.existsSync(path.join(pub, 'index.html')), '公网版/index.html');
const pubCfg = fs.readFileSync(path.join(pub, 'config.js'), 'utf8');
check(!/sk-[a-f0-9]{20,}/.test(pubCfg), '公网版无 DeepSeek key');
check(pubCfg.includes('enableLLM: false'), '公网版关闭大模型');

/* ---- 3. 单文件版真实加载 ---- */
console.log('\n== 3. 单文件版（解压副本，file:// 打开）==');
const single = path.join(APP, '知时智农-单文件版.html');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const PORT = 9320;
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(tmp, 'chrome-profile'),
  'about:blank'
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
const errors = [];

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const l = await r.json();
      const p = l.find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  throw new Error('cdp 连接失败');
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

const fileUrl = 'file:///' + single.replace(/\\/g, '/');

ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push((m.params.exceptionDetails.exception?.description || '').slice(0, 150));
  }
};
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: fileUrl });
await sleep(6000);

let status = '';
for (let i = 0; i < 40; i++) {
  status = await ev("document.getElementById('statusText').textContent");
  if (status && String(status).indexOf('实时数据') >= 0) break;
  await sleep(500);
}
check(String(status).indexOf('实时数据') >= 0, '数据加载成功 (' + status + ')');

const ui = await ev(`(function(){
  return JSON.stringify({
    brand: document.title,
    days: document.querySelectorAll('#days .day').length,
    kpis: document.querySelectorAll('#cards .kpi-item').length,
    conf: document.querySelectorAll('.conf-badge').length,
    charts: document.querySelectorAll('.chart-scroll svg').length,
    win: document.querySelector('.window-date') ? document.querySelector('.window-date').textContent.trim() : ''
  });
})()`);
const U = JSON.parse(ui);
console.log('   标题: ' + U.brand);
console.log('   推荐日: ' + U.win);
check(/知时智农/.test(U.brand), '标题正确');
check(U.days === 7, '七日卡片 7 个');
check(U.kpis === 3, '判断卡 3 张');
check(U.charts >= 4, '图表 ' + U.charts + ' 个');
check(U.conf >= 1, '置信度徽章存在');
check(errors.length === 0, '无未捕获异常');

/* ---- 4. 手机尺寸 ---- */
console.log('\n== 4. 手机尺寸（解压副本）==');
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844
});
await sleep(1200);
const mob = await ev(`(function(){
  var before = window.scrollX;
  window.scrollTo(9999, 0);
  var after = window.scrollX;
  window.scrollTo(before, 0);
  var menu = document.getElementById('menuBtn');
  return JSON.stringify({
    canScrollX: after > 0,
    menuVisible: menu ? menu.getBoundingClientRect().width > 0 : false,
    heroW: document.querySelector('#heroIn') ? Math.round(document.querySelector('#heroIn').getBoundingClientRect().width) : 0
  });
})()`);
const MB = JSON.parse(mob);
check(!MB.canScrollX, '无横向滚动');
check(MB.menuVisible, '汉堡菜单显示');
check(MB.heroW > 300, '窗口卡宽度适配 (' + MB.heroW + 'px)');

/* ---- 5. 本地服务版启动（验证 server.mjs + qr.mjs 齐全）---- */
console.log('\n== 5. 本地服务版能否启动 ==');
const srv = spawn(process.execPath, ['server.mjs', '8966', '--lan'], {
  cwd: path.join(APP, 'web'), stdio: 'pipe'
});
let srvOut = '';
srv.stdout.on('data', d => { srvOut += d.toString(); });
await sleep(2500);

let qrOk = false, appOk = false;
try {
  const r1 = await fetch('http://127.0.0.1:8966/qr');
  qrOk = r1.ok;
  const t1 = await r1.text();
  qrOk = qrOk && t1.includes('<svg');
  const r2 = await fetch('http://127.0.0.1:8966/');
  appOk = r2.ok;
} catch (e) {
  /* 下面报错 */
}
check(qrOk, '/qr 扫码页可用');
check(appOk, '应用首页可用');
check(/手机访问地址/.test(srvOut), '启动横幅显示手机地址');

try { srv.kill(); } catch (e) { /* ignore */ }
try { chrome.kill(); } catch (e) { /* ignore */ }

/* ---- 6. 清理 ---- */
await sleep(400);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n  临时目录已清理');
} catch (e) {
  console.log('\n  （临时目录残留: ' + tmp + '，可手动删除）');
}

console.log(`\n===== 验收结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
