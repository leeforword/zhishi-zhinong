/**
 * server.mjs — 本地静态服务器（零依赖）
 * -------------------------------------------------------------
 * 用法：
 *   node server.mjs [port]          只允许本机访问
 *   node server.mjs [port] --lan    允许同一 WiFi 下的手机访问
 *
 * 为什么要 --lan 开关而不是默认开放：
 *   绑定 0.0.0.0 意味着同一局域网内任何人都能访问你的电脑，
 *   这在宿舍/教室 WiFi 里并不总是合适。所以做成显式选择，
 *   并且启动横幅会明确写出「本机地址」和「手机地址」，
 *   关掉窗口即停止，不留后台。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeQR, renderToTerminal, renderToSVG } from './qr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const PORT = parseInt(args.find(a => /^\d+$/.test(a)) || '8931', 10);
const LAN = args.includes('--lan');

/** 当前这台机器给手机用的地址（没有局域网时退回 localhost） */
function phoneUrl() {
  if (!LAN) return `http://127.0.0.1:${PORT}/`;
  const addrs = lanAddresses();
  return `http://${addrs.length ? addrs[0].ip : '127.0.0.1'}:${PORT}/`;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);

  /* ---- 手机扫码页（动态生成，不占磁盘）----
     为什么要有这一页：终端里的二维码能不能扫，取决于字体宽高比
     是否正好 2:1，Windows 的 cmd.exe 并不保证。浏览器里每个模块
     都是正方形，扫起来稳得多。 */
  if (p === '/qr') {
    const url = phoneUrl();
    let body;
    try {
      const qr = makeQR(url);
      body = renderToSVG(qr, 10, 4);
    } catch (e) {
      body = '<p style="color:#b91c1c">二维码生成失败，请直接访问 ' + url + '</p>';
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>手机扫码 · 知时智农</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
       background:linear-gradient(160deg,#eef4ff,#eefbf3 50%,#fff8ec)}
  .card{background:#fff;border-radius:16px;padding:36px 40px;text-align:center;
        box-shadow:0 12px 40px rgba(16,24,40,.12);max-width:440px}
  h1{font-size:19px;margin:0 0 6px;color:#111827}
  .sub{font-size:13px;color:#6b7280;margin:0 0 22px}
  .qr{padding:10px;border:1px solid #e5e7eb;border-radius:10px;display:inline-block;line-height:0}
  .url{font-family:ui-monospace,Consolas,monospace;font-size:14px;color:#1d4ed8;
       background:#eff6ff;padding:9px 14px;border-radius:8px;margin:18px 0 6px;
       user-select:all;word-break:break-all}
  .tip{font-size:12px;color:#9ca3af;line-height:1.7;margin-top:16px;text-align:left}
  .tip b{color:#6b7280}
</style></head>
<body><div class="card">
  <h1>手机扫这个码</h1>
  <p class="sub">手机需与电脑连同一个 WiFi</p>
  <div class="qr">${body}</div>
  <div class="url">${url}</div>
  <div class="tip">
    <b>扫不动？</b>在手机浏览器里手动输入上面的地址。<br>
    <b>连不上？</b>检查是否同一 WiFi；首次启动若弹出 Windows 防火墙提示，请选「允许」。<br>
    <b>演示结束</b>关闭启动窗口即可，服务不会留在后台。
  </div>
</div></body></html>`);
    return;
  }

  if (p === '/') p = '/index.html';

  // 防目录穿越
  const file = path.join(__dirname, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + p);
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  res.end(fs.readFileSync(file));
});

/** 找出本机的局域网 IPv4 地址（优先 192.168.x / 10.x / 172.16-31.x） */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const ip = info.address;
      // 排除虚拟网卡常见前缀
      if (/^169\.254\./.test(ip)) continue;
      let score = 0;
      if (/^192\.168\./.test(ip)) score = 3;
      else if (/^10\./.test(ip)) score = 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 2;
      out.push({ ip, name, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function banner() {
  const local = `http://127.0.0.1:${PORT}/`;
  console.log('');
  console.log('  ============================================================');
  console.log('   知时智农 · 农事决策助手');
  console.log('  ============================================================');
  console.log('');
  console.log('   本机访问：  ' + local);
  console.log('');

  if (!LAN) {
    console.log('   手机要访问？请用 start.bat 启动（会自动开启局域网访问）');
    console.log('');
    console.log('   关闭本窗口即停止服务。');
    console.log('  ============================================================');
    console.log('');
    return;
  }

  const addrs = lanAddresses();
  if (!addrs.length) {
    console.log('   [提示] 没有检测到局域网地址，请确认已连接 WiFi。');
    console.log('   关闭本窗口即停止服务。');
    console.log('  ============================================================');
    console.log('');
    return;
  }

  // 只在检测到多个地址时列出全部，便于判断哪个是 WiFi
  if (addrs.length > 1) {
    console.log('   检测到多个网络地址：');
    addrs.forEach(a => console.log('     · ' + a.ip + '   (' + a.name + ')'));
    console.log('');
  }

  const ip = addrs[0].ip;
  const url = `http://${ip}:${PORT}/`;
  console.log('   手机访问地址（手机需连同一个 WiFi）：');
  console.log('');
  console.log('     ' + url);
  console.log('');
  console.log('   推荐：用浏览器打开下面这个页面，二维码更大更好扫');
  console.log('');
  console.log('     http://127.0.0.1:' + PORT + '/qr');
  console.log('');

  try {
    const qr = makeQR(url);
    const lines = renderToTerminal(qr, 3);
    console.log('   用手机相机 / 微信扫下面这个码：');
    console.log('');
    lines.forEach(l => console.log('     ' + l));
    console.log('');
  } catch (e) {
    // 二维码生成失败不影响服务，地址照样能手动输入
    console.log('   （二维码生成失败，请手动输入上面的地址）');
    console.log('');
  }

  console.log('   注意：');
  console.log('     · 手机和电脑必须连同一个 WiFi');
  console.log('     · 首次启动如果弹出 Windows 防火墙提示，请选「允许访问」');
  console.log('     · 演示结束后关闭本窗口即可，服务不会留在后台');
  console.log('  ============================================================');
  console.log('');
}

server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  banner();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('');
    console.log('  [错误] 端口 ' + PORT + ' 已被占用。');
    console.log('  请关闭占用该端口的程序，或换个端口：');
    console.log('     node server.mjs ' + (PORT + 1) + (LAN ? ' --lan' : ''));
    console.log('');
  } else {
    console.log('  [错误] ' + e.message);
  }
  process.exit(1);
});
