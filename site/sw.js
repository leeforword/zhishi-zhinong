/* =============================================================
   知时智农 · Service Worker
   -------------------------------------------------------------
   只做两件事：让 App 能被「安装」到手机桌面，以及断网时界面还能打开。

   ★ 一条不可妥协的原则：绝不缓存天气 / 地图 / 大模型接口的返回。
     这是农事决策工具，不是内容网站。如果缓存了昨天的天气并当成本次结果
     展示，用户会按过期数据决定打不打药——这比「打不开」危险得多。
     所以跨域请求（Open-Meteo、和风、高德、DeepSeek）一律不拦截，
     交给浏览器原样处理；接口失败时由页面自己显示「需要联网」。
     ——宁可诚实地说取不到，也不给一个看起来正常的旧答案。

   缓存策略：
     · 导航请求（打开页面）：网络优先，失败回退到上次缓存的外壳
     · 同源静态资源：网络优先，失败回退缓存（保证新旧文件版本一致）
     · 跨域接口：不拦截、不缓存
   ============================================================= */

/* build-site.mjs 会把 __BUILD__ 替换成构建时间戳；
   开发时（web/ 目录直接打开）保持 dev，不影响使用 */
const BUILD_ID = '20261113143641';
const VERSION = /^__BUILD__$/.test(BUILD_ID) ? 'dev' : BUILD_ID;

const CACHE = 'zhishi-zhinong-' + VERSION;
const NET_TIMEOUT = 4500;

/* 应用外壳：离线时需要能完整打开的界面 */
const SHELL = [
  './',
  './index.html',
  './config.js',
  './settings.js',
  './llm.js',
  './weather.js',
  './hebei-geo.js',
  './place.js',
  './logic.js',
  './ensemble.js',
  './app.js',
  './pwa.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

/* 极端情况：缓存是空的又恰好断网，给一个能看懂的最小页面 */
const OFFLINE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>离线 · 知时智农</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
       background:#f7f8fa;color:#111827;padding:24px;box-sizing:border-box}
  .c{max-width:340px;text-align:center}
  h1{font-size:17px;margin:0 0 10px}
  p{font-size:13px;line-height:1.8;color:#6b7280;margin:0 0 18px}
  button{font-size:13px;padding:9px 18px;border-radius:8px;border:1px solid #2563eb;
         background:#2563eb;color:#fff;cursor:pointer}
</style></head>
<body><div class="c">
  <h1>现在打不开</h1>
  <p>这是第一次安装，应用还没缓存完整。<br>请连上网络后重试一次。</p>
  <button onclick="location.reload()">重新加载</button>
</div></body></html>`;

/* ---------- 安装：预先缓存外壳 ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个缓存：某一个文件 404 不至于让整次安装失败
    await Promise.all(SHELL.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (e) {
        /* 单个资源失败可忽略，fetch 时会再试 */
      }
    }));
  })());
});

/* ---------- 激活：删掉旧版本缓存 ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('zhishi-zhinong-') && n !== CACHE)
           .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ---------- 新版本接管：由页面上的「立即更新」触发 ---------- */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: VERSION });
  }
});

/* ---------- 取数 ---------- */
function withTimeout(promise) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), NET_TIMEOUT);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function networkFirst(request, fallbackKey) {
  const cache = await caches.open(CACHE);

  try {
    const res = await withTimeout(fetch(request));
    if (res && res.ok && res.type === 'basic') {
      cache.put(fallbackKey || request, res.clone()).catch(() => {});
      return res;
    }
    // 404 / 500 也走缓存，避免服务器抖动导致白屏
    throw new Error('bad status ' + (res && res.status));
  } catch (e) {
    const hit = (fallbackKey && await cache.match(fallbackKey)) || await cache.match(request);
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理同源的 GET；跨域接口（天气/地图/AI）完全不碰
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // 打开页面：网络优先，失败用缓存的外壳
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await networkFirst(req, './index.html');
      } catch (e) {
        const cache = await caches.open(CACHE);
        const shell = await cache.match('./index.html') || await cache.match('./');
        if (shell) return shell;
        return new Response(OFFLINE_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // 静态资源：网络优先，失败回退缓存
  event.respondWith((async () => {
    try {
      return await networkFirst(req);
    } catch (e) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
