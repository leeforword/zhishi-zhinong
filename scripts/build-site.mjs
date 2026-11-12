/**
 * build-site.mjs — 生成可托管到 GitHub Pages 的纯静态站点
 * -------------------------------------------------------------
 * 输入：web/（开发目录，含个人 key、本地服务器、测试脚本）
 * 输出：site/（可以整个丢到任何静态托管上的成品）
 *
 * 做三件事：
 *   1. 只挑运行时需要的文件，测试脚本 / 本地服务器 / 私有配置一律不进
 *   2. 保证成果里一个 DeepSeek key 都没有（按量计费，公开等于送钱）
 *   3. 自检：页面引用的文件、Service Worker 预缓存的文件、桌面图标清单
 *      三份列表必须都能在产物里找到，否则构建失败
 *
 * 为什么第 3 步值得写：
 *   Service Worker 的预缓存列表是手写的，改了文件名忘了同步，
 *   表现是「装到手机后一断网就白屏」——在电脑上永远不会发现。
 *   所以宁可构建时报错，也不要线上出现这个问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'site');
const SHOTS = path.join(ROOT, 'screenshots');

const log = (...a) => console.log(...a);
const fail = [];
function check(name, ok, detail) {
  log('  ' + (ok ? 'OK   ' : 'FAIL ') + name + (detail ? '  → ' + detail : ''));
  if (!ok) fail.push(name + (detail ? ' (' + detail + ')' : ''));
  return ok;
}

log('=== 构建静态站点 ===\n');

/* ------------------------------------------------------------
   一、清空产物目录
   ------------------------------------------------------------ */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------
   二、运行时文件清单
   ------------------------------------------------------------ */
const JS_FILES = ['llm.js', 'weather.js', 'hebei-geo.js', 'logic.js', 'ensemble.js', 'app.js', 'pwa.js'];

let copied = 0;
function copy(rel, dest) {
  const from = path.join(WEB, rel);
  const to = path.join(OUT, dest || rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
}

/* ---- 1. index.html：去掉本地私有配置那一行 ---- */
let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const beforeLen = html.length;
html = html.replace(
  /\s*<!-- 本地私有配置[^\n]*\n\s*<script src="config\.local\.js"><\/script>/,
  ''
);
if (html.length === beforeLen) {
  // 注释被改过也要能去掉，退一步只删 script 标签
  html = html.replace(/\s*<script src="config\.local\.js"><\/script>/, '');
}
fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');
copied++;
check('index.html 已移除 config.local.js 引用', !html.includes('config.local.js'));

/* ---- 2. 其余脚本 ---- */
for (const f of JS_FILES) copy(f);

/* ---- 3. config.js：把 key 相关的安全处理再做一遍兜底 ---- */
let cfg = fs.readFileSync(path.join(WEB, 'config.js'), 'utf8');
cfg = cfg.replace(/deepseekKey:\s*'[^']*'/, "deepseekKey: ''");
cfg = cfg.replace(/enableLLM:\s*true/, 'enableLLM: false');
fs.writeFileSync(path.join(OUT, 'config.js'), cfg, 'utf8');
copied++;

/* ---- 4. Service Worker：写入构建号，让每次发布都是新缓存 ---- */
const buildId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
let sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
sw = sw.replace("'__BUILD__'", "'" + buildId + "'");
fs.writeFileSync(path.join(OUT, 'sw.js'), sw, 'utf8');
copied++;
check('sw.js 已写入构建号', sw.includes("'" + buildId + "'"), buildId);

/* ---- 5. 桌面图标清单 ---- */
copy('manifest.webmanifest');

/* ---- 6. 图标 ---- */
for (const f of fs.readdirSync(path.join(WEB, 'icons'))) {
  copy(path.join('icons', f));
}

/* ---- 7. 安装引导里用到的两张截图 ---- */
fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
for (const f of ['01-desktop-overview.png', '12-mobile-iphone.png']) {
  const from = path.join(SHOTS, f);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(OUT, 'screenshots', f));
    copied++;
  }
}

/* ---- 8. .nojekyll：阻止 GitHub Pages 用 Jekyll 处理静态文件 ---- */
fs.writeFileSync(path.join(OUT, '.nojekyll'), '', 'utf8');
copied++;

log(`\n  已复制 ${copied} 个文件\n`);

/* ------------------------------------------------------------
   三、自检
   ------------------------------------------------------------ */
log('=== 自检 ===');

/* 3.1 不能有任何 DeepSeek key */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const outFiles = walk(OUT);
const textFiles = outFiles.filter((f) => /\.(js|html|json|webmanifest|txt)$/.test(f));
const leaked = textFiles.filter((f) => /sk-[a-zA-Z0-9]{20,}/.test(fs.readFileSync(f, 'utf8')));
check('产物里没有 DeepSeek key', leaked.length === 0, leaked.map((f) => path.relative(OUT, f)).join(', '));

/* 3.2 manifest 合法且图标齐全 */
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.webmanifest'), 'utf8'));
} catch (e) {
  check('manifest.webmanifest 是合法 JSON', false, e.message);
}
if (manifest) {
  check('manifest 是合法 JSON', true);
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
    check('manifest 含 ' + k, k in manifest);
  }
  const png512 = (manifest.icons || []).some((i) => i.sizes === '512x512' && /png$/.test(i.src));
  const maskable = (manifest.icons || []).some((i) => i.purpose === 'maskable');
  check('提供了 512×512 PNG', png512);
  check('提供了 maskable 图标', maskable);
}

/* 3.3 页面引用的每个本地文件都存在 */
const htmlOut = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const refs = new Set();
for (const m of htmlOut.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const u = m[1];
  if (/^(https?:|data:|#|mailto:)/.test(u)) continue;
  refs.add(u);
}
const missingRefs = [...refs].filter((u) => !fs.existsSync(path.join(OUT, u.replace(/^\.\//, ''))));
check('index.html 引用的 ' + refs.size + ' 个本地文件都存在', missingRefs.length === 0, missingRefs.join(', '));

/* 3.4 Service Worker 预缓存列表里的文件都要存在 */
const swOut = fs.readFileSync(path.join(OUT, 'sw.js'), 'utf8');
const shellBlock = swOut.match(/const SHELL = \[([\s\S]*?)\];/);
const shellList = shellBlock ? [...shellBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
const missingShell = shellList.filter((u) => {
  if (u === './' || u.endsWith('/')) return false;
  return !fs.existsSync(path.join(OUT, u.replace(/^\.\//, '')));
});
check('SW 预缓存清单 ' + shellList.length + ' 项均存在', shellList.length > 0 && missingShell.length === 0, missingShell.join(', '));

/* 3.5 不该出现的文件确实没出现 */
check('没有复制 config.local.js', !fs.existsSync(path.join(OUT, 'config.local.js')));
check('没有复制 server.mjs / 测试脚本',
  !fs.existsSync(path.join(OUT, 'server.mjs')) && !fs.existsSync(path.join(OUT, 'e2e.mjs')));

/* 3.6 体积 */
const total = outFiles.reduce((s, f) => s + fs.statSync(f).size, 0);
log('\n  产物体积：' + (total / 1024).toFixed(0) + ' KB（' + outFiles.length + ' 个文件）');
log('  输出目录：' + OUT);

if (fail.length) {
  log('\n构建失败，以下检查未通过：');
  fail.forEach((f) => log('  · ' + f));
  process.exit(1);
}

log('\n构建成功。');
