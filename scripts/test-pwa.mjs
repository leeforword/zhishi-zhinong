/**
 * test-pwa.mjs — 真浏览器验证「静态版 + 可安装 + 可离线」
 * -------------------------------------------------------------
 * ASCII only on purpose (PowerShell encoding), same convention as e2e.mjs.
 *
 * 验证的是「装到手机」这件事能不能成，而不是界面好不好看：
 *   1. 纯静态服务（和后端一点关系都没有）能不能打开
 *   2. manifest 能不能取到、图标是不是 200
 *   3. Service Worker 能不能注册成功并激活
 *   4. Chrome 自己认为这个站能不能安装（getInstallabilityErrors 必须为空）
 *   5. 断网之后刷新，界面还能不能出来
 *
 * 为什么第 4 项最关键：
 *   安装按钮能不能出现完全由浏览器判定，人眼看不出来。
 *   Chrome 会给出具体的拒绝原因（比如图标尺寸不对、start_url 越界），
 *   有这条断言，改坏了当场就知道。
 *
 * 用法：node scripts/test-pwa.mjs [dir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIR = path.resolve(ROOT, process.argv[2] || 'site');
const PORT = 8977;
const CDP_PORT = 9247;

/* 传 --url=https://xxx.github.io/repo/ 就直接测线上，
   不带就本地起一个服务器测 site/。线上版才能验到真东西：
   HTTPS、CDN 的 Content-Type、以及 GitHub Pages 真实的子路径。 */
const LIVE = (() => {
  const a = process.argv.find((x) => x.startsWith('--url='));
  return a ? a.slice('--url='.length).replace(/\/?$/, '/') : null;
})();

/* GitHub Pages 的站点挂在 /<仓库名>/ 这样的子路径下，而不是域名根目录。
   子路径是最容易暴露 scope / start_url 写错的地方（manifest 用绝对路径就会装不上），
   所以默认就按真实部署的子路径来测，也支持 --base=/ 回退到根目录。 */
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=/zhishi-zhinong/')
  .slice('--base='.length)
  .replace(/\/?$/, '/');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

if (!CHROME) { console.error('Chrome/Edge not found'); process.exit(1); }
if (!LIVE && !fs.existsSync(path.join(DIR, 'index.html'))) {
  console.error('No index.html in ' + DIR + ' -- run: node scripts/build-site.mjs');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 静态服务器（等价于 GitHub Pages 的行为） ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8'
};

let server = null;
let SITE;

if (LIVE) {
  SITE = LIVE;
  console.log('target ' + SITE + '  (live URL)\n');
} else {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    // 只在这个子路径下提供服务，模拟 GitHub Pages 的 /<repo>/ 结构
    if (!p.startsWith(BASE)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404');
      return;
    }
    p = '/' + p.slice(BASE.length);
    if (p === '/') p = '/index.html';
    const file = path.join(DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(fs.readFileSync(file));
  });

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  SITE = 'http://127.0.0.1:' + PORT + BASE;
  console.log('serving ' + DIR + '\n       at ' + SITE + '  (base ' + BASE + ')\n');
}

/* ---------------- 启动 Chrome ---------------- */
const userDataDir = path.join(process.env.TEMP || '.', 'cdp_pwa_' + Date.now());
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + userDataDir,
  '--window-size=1600,1200', 'about:blank'
], { stdio: 'ignore' });

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* not ready */ }
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
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error('JS exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  }
  return r.result ? r.result.value : undefined;
}

let pass = 0, fail = 0;
function check(cond, msg, detail) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (detail ? '  >> ' + detail : '')); }
}

function cleanup(code) {
  try { ws && ws.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
  try { if (server) server.close(); } catch (e) {}
  setTimeout(() => process.exit(code), 250);
}

try {
  const wsUrl = await getTarget();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws error'));
  });

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.text || 'exception');
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  /* ============ 1. 静态资源可达 ============ */
  console.log('=== 1. static assets ===');
  for (const f of ['/index.html', '/manifest.webmanifest', '/sw.js', '/pwa.js',
                   '/icons/icon-192.png', '/icons/icon-512.png',
                   '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png']) {
    let status = 0, type = '';
    try {
      const r = await fetch(SITE + f.slice(1));
      status = r.status;
      type = r.headers.get('content-type') || '';
    } catch (e) { /* remains 0 */ }
    check(status === 200, 'GET ' + f, 'status=' + status);
    if (f.endsWith('.webmanifest')) {
      check(/manifest\+json/.test(type), 'manifest served as manifest+json', type);
    }
  }

  /* ============ 2. manifest 内容 ============ */
  console.log('\n=== 2. manifest ===');
  const man = await (await fetch(SITE + 'manifest.webmanifest')).json();
  check(man.name && man.name.length > 0, 'has name');
  check(!!man.short_name, 'has short_name');
  check(man.start_url === './', 'start_url is relative', String(man.start_url));
  check(man.scope === './', 'scope is relative', String(man.scope));
  check(man.display === 'standalone', 'display is standalone');
  for (const icon of man.icons || []) {
    const r = await fetch(SITE + icon.src);
    check(r.status === 200, 'icon reachable: ' + icon.src);
  }

  /* ============ 3. 打开页面 ============ */
  console.log('\n=== 3. page load ===');
  await send('Page.navigate', { url: SITE });
  await sleep(3500);

  const title = await ev('document.title');
  check(/知时智农/.test(title), 'title rendered', title);
  check(await ev('!!document.querySelector(".sidebar")'), 'app shell mounted');
  check(await ev('!!document.querySelector("link[rel=manifest]")'), 'manifest link present');
  check(await ev('document.documentElement.classList.contains("zz-browser")'),
    'pwa.js booted (html.zz-browser set)');

  /* ============ 4. Service Worker ============ */
  console.log('\n=== 4. service worker ===');
  let swState = null;
  for (let i = 0; i < 24; i++) {
    swState = await ev(
      '(async()=>{const r=await navigator.serviceWorker.getRegistration();' +
      'if(!r)return null;return {active:r.active&&r.active.state,scope:r.scope,' +
      'controlled:!!navigator.serviceWorker.controller};})()'
    );
    if (swState && swState.active === 'activated' && swState.controlled) break;
    await sleep(500);
  }
  check(!!swState, 'service worker registered');
  check(swState && swState.active === 'activated', 'service worker activated',
    swState ? swState.active : 'none');
  check(swState && swState.scope.replace(/\/$/, '') === SITE.replace(/\/$/, ''), 'scope covers the site',
    swState ? swState.scope : '');

  const cacheKeys = await ev('caches.keys()');
  check(Array.isArray(cacheKeys) && cacheKeys.some((k) => k.startsWith('zhishi-zhinong-')),
    'cache created', JSON.stringify(cacheKeys));

  const cachedShell = await ev(
    '(async()=>{const ns=await caches.keys();for(const n of ns){if(!n.startsWith("zhishi-zhinong-"))continue;' +
    'const c=await caches.open(n);if(await c.match("./index.html"))return true;' +
    'if(await c.match("/index.html"))return true;}return false;})()'
  );
  check(cachedShell === true, 'index.html precached');

  /* ============ 5. 浏览器自己的安装判定 ============ */
  console.log('\n=== 5. installability (Chrome verdict) ===');
  let installErrors = null;
  try {
    const r = await send('Page.getInstallabilityErrors');
    installErrors = (r.installabilityErrors || []).map((e) => e.errorId + ': ' + (e.errorArguments || ''));
  } catch (e) {
    installErrors = ['unavailable: ' + e.message];
  }
  check(Array.isArray(installErrors) && installErrors.length === 0,
    'Chrome reports no installability errors', JSON.stringify(installErrors));

  /* manifest 解析结果也看一下 */
  try {
    const mf = await send('Page.getAppManifest');
    check(!mf.errors || mf.errors.length === 0, 'manifest parsed without errors',
      JSON.stringify((mf.errors || []).map((x) => x.message)));
  } catch (e) { /* older Chrome */ }

  /* ============ 6. 断网后仍能打开 ============ */
  console.log('\n=== 6. offline reload ===');
  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
  });
  await send('Page.navigate', { url: SITE });
  await sleep(3000);

  const offlineTitle = await ev('document.title');
  const offlineBrand = await ev(
    '(document.body && document.body.innerText || "").indexOf("知时智农") >= 0'
  );
  check(/知时智农/.test(offlineTitle), 'page opens while offline', offlineTitle);
  check(offlineBrand === true, 'shell content rendered offline');

  const offlineMsg = await ev(
    '(document.body && document.body.innerText || "").replace(/\\s+/g," ").slice(0, 4000)'
  );
  check(/需要联网|取不到|没有网络/.test(offlineMsg),
    'offline state explained to user (not silent)');

  await send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
  });

  /* ============ 7. 控制台干净 ============ */
  console.log('\n=== 7. console ===');
  const realErrors = pageErrors.filter((e) => !/Failed to load resource/i.test(e));
  check(realErrors.length === 0, 'no uncaught JS exceptions', realErrors.slice(0, 3).join(' | '));

  const unexpected = consoleErrors.filter(
    (e) => !/Failed to load resource|net::ERR|CORS|open-meteo|qweather|amap|deepseek|favicon/i.test(e)
  );
  check(unexpected.length === 0, 'no unexpected console errors', unexpected.slice(0, 3).join(' | '));

} catch (e) {
  fail++;
  console.log('\n  FAIL harness: ' + e.message);
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '  pass=' + pass + ' fail=' + fail);
cleanup(fail === 0 ? 0 : 1);
