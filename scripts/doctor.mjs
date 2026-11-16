/**
 * doctor.mjs — 交接自检（只读，不修改任何文件）
 * -------------------------------------------------------------
 * 用途：换一台机器、换一个 AI 接手时，用一条命令确认
 *   「环境齐不齐、三处清单对不对得上、产物是不是最新的」
 *
 * 用法：
 *   node scripts/doctor.mjs
 *
 * 它检查的是这份项目里最容易出错、且出错后最难发现的地方：
 *   1. 关键文件是否都在
 *   2. 所有运行时 JS 是否语法可解析（node --check）
 *   3. 新增一个 JS 文件时，三处清单是否同步：
 *        index.html 的 <script> 顺序 / sw.js 的 SHELL / build-site.mjs 的 JS_FILES
 *      —— 只加一处，表现是「线上白屏」或「断网白屏」，本地不一定能复现
 *   4. manifest 是否合法、图标是否齐
 *   5. config.js 是否还残留按量计费的 key
 *   6. site/ 是否与 web/ 一致（sw.js 的构建号、config.js 的脱敏属预期差异）
 *   7. git 分支 / 远端 / 未提交改动
 *
 * 不做的事：不跑构建、不跑网络测试、不写文件。
 * 需要更深验证请依次执行：
 *   node web/test-logic.mjs
 *   node web/server.mjs 8931      （另开一个终端）
 *   node web/e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'site');

let pass = 0, warn = 0, fail = 0;
const notes = [];

function ok(name, detail) {
  pass++;
  console.log('  OK   ' + name + (detail ? '  → ' + detail : ''));
}
function wr(name, detail) {
  warn++;
  console.log('  WARN ' + name + (detail ? '  → ' + detail : ''));
}
function bad(name, detail) {
  fail++;
  console.log('  FAIL ' + name + (detail ? '  → ' + detail : ''));
}
function head(t) { console.log('\n' + t); }

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

/* ---------- 0. Node 版本 ---------- */
head('== 0. 运行环境 ==');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok('Node ' + process.version + '（>=18，自带 fetch）');
else bad('Node ' + process.version + ' 过低，需要 >= 18');
console.log('  平台 ' + process.platform + ' / ' + process.arch + ' / 工作区 ' + ROOT);

/* ---------- 1. 关键文件 ---------- */
head('== 1. 关键文件 ==');
const REQUIRED = [
  'web/index.html', 'web/app.js', 'web/content.js', 'web/logic.js', 'web/weather.js',
  'web/place.js', 'web/ensemble.js', 'web/llm.js', 'web/settings.js', 'web/pwa.js',
  'web/sw.js', 'web/config.js', 'web/config.local.js', 'web/manifest.webmanifest',
  'web/hebei-geo.js', 'scripts/build-site.mjs', '.github/workflows/deploy.yml',
  'worker/ai-proxy.js', 'android-webview/build.sh', 'android-webview/AndroidManifest.xml'
];
for (const f of REQUIRED) {
  if (exists(path.join(ROOT, f))) ok(f);
  else if (f === 'web/config.local.js') wr(f + ' 不存在（可接受：没有它 AI 润色默认关闭）');
  else bad(f + ' 缺失');
}

/* ---------- 2. 语法 ---------- */
head('== 2. 语法检查 ==');
const RUNTIME_JS = ['config.js', 'settings.js', 'llm.js', 'weather.js', 'hebei-geo.js',
  'place.js', 'logic.js', 'content.js', 'ensemble.js', 'app.js', 'pwa.js', 'sw.js'];
for (const f of RUNTIME_JS) {
  const p = path.join(WEB, f);
  if (!exists(p)) continue;
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
    ok(f);
  } catch (e) {
    bad(f + ' 语法错误', String(e.stderr || e.message).split('\n')[0]);
  }
}

/* ---------- 3. 三处清单一致性 ---------- */
head('== 3. 脚本清单一致性（新增文件最容易漏的地方）==');
let htmlScripts = [];
try {
  const html = read(path.join(WEB, 'index.html'));
  htmlScripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s !== 'config.local.js');
} catch (e) { bad('读取 web/index.html 失败', e.message); }

let swShell = [];
try {
  const sw = read(path.join(WEB, 'sw.js'));
  const block = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  swShell = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
} catch (e) { bad('读取 web/sw.js 失败', e.message); }

let buildList = [];
try {
  const b = read(path.join(ROOT, 'scripts/build-site.mjs'));
  const block = b.match(/const JS_FILES = \[([^\]]*)\]/);
  buildList = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
} catch (e) { bad('读取 scripts/build-site.mjs 失败', e.message); }

const norm = (list) => list.filter((s) => s.endsWith('.js'));
const A = norm(htmlScripts), B = norm(buildList);
const C = norm(swShell).map((s) => s.replace(/^\.\//, ''));

/* config.js 是构建脚本单独处理的（要脱敏），不在 JS_FILES 里，属正常 */
const A2 = A.filter((f) => f !== 'config.js');
const missInHtml = B.filter((f) => !A.includes(f));
const missInBuild = A2.filter((f) => !B.includes(f));
const missInSw = [...new Set([...A, ...B])].filter((f) => !C.includes(f));

if (!A.length || !B.length) bad('清单解析失败，检查文件格式是否被改动');
else {
  missInHtml.length ? bad('build-site 有但 index.html 未引用', missInHtml.join(', '))
    : ok('index.html 引用的 ' + A.length + ' 个脚本都在 build-site 清单内');
  missInBuild.length ? bad('index.html 引用但 build-site 未复制', missInBuild.join(', '))
    : ok('build-site 会复制除 config.js 外的全部 ' + B.length + ' 个运行时脚本');
  missInSw.length ? wr('SW 预缓存清单缺这些文件（断网时对应功能不可用）', missInSw.join(', '))
    : ok('SW 预缓存清单覆盖全部脚本');
}
for (const f of A) {
  if (!exists(path.join(WEB, f))) bad('index.html 引用了不存在的文件', f);
}
const swMissing = swShell
  .filter((u) => u !== './' && !u.endsWith('/'))
  .filter((u) => !exists(path.join(WEB, u.replace(/^\.\//, ''))));
swMissing.length ? bad('SW 清单里的文件不存在', swMissing.join(', '))
  : ok('SW 预缓存 ' + swShell.length + ' 项在磁盘上都存在');

/* ---------- 4. manifest ---------- */
head('== 4. PWA 清单 ==');
try {
  const m = JSON.parse(read(path.join(WEB, 'manifest.webmanifest')));
  const need = ['name', 'short_name', 'start_url', 'scope', 'display', 'icons'];
  const lack = need.filter((k) => !(k in m));
  lack.length ? bad('manifest 缺字段', lack.join(', ')) : ok('manifest 合法，必备字段齐');
  const icons = m.icons || [];
  const has512 = icons.some((i) => i.sizes === '512x512' && /png$/.test(i.src));
  const maskable = icons.some((i) => i.purpose === 'maskable');
  has512 ? ok('含 512×512 PNG') : bad('缺 512×512 PNG');
  maskable ? ok('含 maskable 图标') : bad('缺 maskable 图标');
  for (const i of icons) {
    if (!exists(path.join(WEB, i.src))) bad('图标文件缺失', i.src);
  }
} catch (e) { bad('manifest 解析失败', e.message); }

/* ---------- 5. 配置安全 ---------- */
head('== 5. 配置与密钥 ==');
try {
  const cfg = read(path.join(WEB, 'config.js'));
  /* 先去掉块注释：文件头示例里就写着 deepseekKey: '你的 key'，
     不剥离会把这个示例当成真实 key 误报。 */
  const code = cfg.replace(/\/\*[\s\S]*?\*\//g, '');
  const grab = (k) => {
    const m = code.match(new RegExp(k + "\\s*:\\s*'([^']*)'"));
    return m ? m[1] : null;
  };
  const ds = grab('deepseekKey');
  if (ds === '') ok('config.js 的 deepseekKey 为空（公网版必须如此）');
  else if (ds === null) wr('config.js 找不到 deepseekKey 字段，构建脱敏正则可能失效');
  else bad('config.js 里的 deepseekKey 非空，公开仓库会泄露计费 key');

  for (const k of ['amapKey', 'amapWebKey', 'qweatherKey', 'qweatherHost']) {
    const v = grab(k);
    if (!v) wr(k + ' 为空，对应功能会降级');
    else ok(k + ' 已配置（前端公开，靠域名白名单/额度兜底）');
  }
  const prefer = grab('preferSource');
  ok('preferSource = ' + (prefer || '未设置（默认 qweather）'));

  if (exists(path.join(WEB, 'config.local.js'))) {
    const local = read(path.join(WEB, 'config.local.js'));
    if (/sk-[a-zA-Z0-9]{20,}/.test(local)) {
      wr('config.local.js 含明文大模型 key（已被 gitignore，但不要提交/录屏；怀疑泄露就轮换）');
    } else ok('config.local.js 不含 sk- 形式的 key');
  }
  const gi = exists(path.join(ROOT, '.gitignore')) ? read(path.join(ROOT, '.gitignore')) : '';
  gi.includes('web/config.local.js') ? ok('.gitignore 已忽略 web/config.local.js')
    : bad('.gitignore 未忽略 web/config.local.js');
} catch (e) { bad('读取配置失败', e.message); }

/* ---------- 6. site/ 与 web/ 是否同步 ---------- */
head('== 6. 发布产物是否最新 ==');
if (!exists(OUT)) {
  wr('site/ 不存在，先执行 node scripts/build-site.mjs');
} else {
  const hash = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  const EXPECT_DIFF = new Set(['sw.js', 'config.js']); // 构建号 / 脱敏，属预期差异
  /* index.html 在产物里会删掉 config.local.js 那一行，先归一化再比 */
  const stripLocal = (s) => s
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]*<!--[^\n]*本地私有配置[^\n]*-->[ \t]*\n[ \t]*<script src="config\.local\.js"><\/script>/, '')
    .replace(/\n[ \t]*<script src="config\.local\.js"><\/script>/, '');
  let stale = [], same = 0;
  for (const f of [...B, 'index.html', 'manifest.webmanifest']) {
    const a = path.join(WEB, f), b = path.join(OUT, f);
    if (!exists(a) || !exists(b)) { stale.push(f + '(缺失)'); continue; }
    if (EXPECT_DIFF.has(f)) continue;
    if (f === 'index.html') {
      if (stripLocal(read(a)) === stripLocal(read(b))) same++;
      else stale.push(f);
      continue;
    }
    if (hash(a) === hash(b)) same++;
    else stale.push(f);
  }
  stale.length
    ? wr('site/ 有 ' + stale.length + ' 个文件与 web/ 不同，可能未重新构建', stale.slice(0, 6).join(', '))
    : ok('site/ 与 web/ 一致的运行时文件 ' + same + ' 个（sw.js/config.js 差异属预期）');
  const files = fs.readdirSync(OUT);
  const verify = files.filter((f) => /^[a-f0-9]{32}\.txt$/i.test(f));
  verify.length ? ok('微信验证文件在产物根目录：' + verify.join(', '))
    : wr('site/ 根目录没有微信域名验证文件（若微信申诉在用，构建后必须存在）');
  exists(path.join(OUT, '.well-known', 'assetlinks.json'))
    ? ok('assetlinks.json 已随构建发布') : wr('.well-known/assetlinks.json 缺失（TWA 相关，WebView 壳不依赖）');
  exists(path.join(OUT, 'download', 'zhishi-zhinong.apk'))
    ? ok('安卓安装包已随构建发布') : wr('site/download/ 下没有 APK');
}

/* ---------- 7. git ---------- */
head('== 7. 版本状态 ==');
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
  } catch (e) { return ''; }
};
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const remote = git(['remote', 'get-url', 'origin']);
const status = git(['status', '--porcelain']);
const last = git(['log', '-1', '--pretty=%h %s']);
branch ? ok('分支 ' + branch) : wr('不是 git 仓库或无法读取分支');
remote ? ok('远端 ' + remote) : wr('未配置 origin');
last ? ok('最近提交 ' + last) : wr('没有提交记录');
if (!status) ok('工作区干净');
else {
  const lines = status.split('\n');
  wr('有 ' + lines.length + ' 处未提交改动（只有 site/sw.js 时属构建号变化，正常）', lines.slice(0, 4).join(' | '));
}

/* ---------- 总结 ---------- */
console.log('\n===== 自检结果：通过 ' + pass + ' / 警告 ' + warn + ' / 失败 ' + fail + ' =====');
if (fail) {
  console.log('有失败项，先修再改代码。详见上方 FAIL 行。');
  process.exit(1);
}
console.log('接下来建议：');
console.log('  node web/test-logic.mjs          # 规则引擎（需要网络，取实时天气）');
console.log('  node web/server.mjs 8931         # 另开终端');
console.log('  node web/e2e.mjs                 # 浏览器端到端（需要 Chrome/Edge）');
console.log('  node scripts/build-site.mjs      # 生成 site/，再 push 触发部署');
