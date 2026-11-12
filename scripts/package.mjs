/**
 * package.mjs — 一键生成全部交付产物
 * -------------------------------------------------------------
 * 运行这一个脚本会依次产出：
 *
 *   1. dist/知时智农/                  完整多文件版（本地使用 / 二次开发）
 *   2. dist/知时智农/知时智农-单文件版.html   单文件版（发给别人最省事）
 *   3. dist/知时智农/公网版/             已做安全处理的公网托管版
 *   4. dist/知时智农.zip               上面所有东西的压缩包
 *
 * 注意执行顺序：单文件版和公网版必须先于 zip 生成，
 * 否则包里会缺这两个目录。所以本脚本会先调用那两个构建脚本。
 */
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = '知时智农';

/* ---- 第 0 步：先构建派生版本（必须在打包前）---- */
console.log('=== 0. 构建派生版本 ===\n');

const builders = [
  ['build-single.mjs', '单文件版'],
  ['build-public.mjs', '公网版']
];
for (const [script, label] of builders) {
  const p = path.join(__dirname, script);
  if (!fs.existsSync(p)) {
    console.log('  跳过（脚本不存在）: ' + script);
    continue;
  }
  try {
    execFileSync(process.execPath, [p], { cwd: __dirname, stdio: 'pipe' });
    console.log('  OK  ' + label + ' 已生成');
  } catch (e) {
    console.log('  FAIL ' + label + ' 生成失败:');
    console.log((e.stdout || '').toString().split('\n').slice(-12).join('\n'));
    process.exit(1);
  }
}

/* ---- 第 1 步：准备 staging 目录（只清理自己的部分）---- */
console.log('\n=== 1. 组装交付包 ===\n');

const stage = path.join(DIST, NAME);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

/* ---- 第 2 步：复制运行必需文件 ---- */
const files = [
  ['使用说明.txt', '使用说明.txt'],
  ['start.bat', 'start.bat'],
  ['web/index.html', 'web/index.html'],
  ['web/config.js', 'web/config.js'],
  ['web/llm.js', 'web/llm.js'],
  ['web/weather.js', 'web/weather.js'],
  ['web/hebei-geo.js', 'web/hebei-geo.js'],
  ['web/place.js', 'web/place.js'],
  ['web/logic.js', 'web/logic.js'],
  ['web/ensemble.js', 'web/ensemble.js'],
  ['web/app.js', 'web/app.js'],
  ['web/pwa.js', 'web/pwa.js'],
  ['web/sw.js', 'web/sw.js'],
  ['web/manifest.webmanifest', 'web/manifest.webmanifest'],
  ['web/server.mjs', 'web/server.mjs'],
  ['web/qr.mjs', 'web/qr.mjs']
];

let total = 0;
for (const [src, dst] of files) {
  const from = path.join(ROOT, src);
  const to = path.join(stage, dst);
  if (!fs.existsSync(from)) {
    console.log('  缺失: ' + src);
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  total += fs.statSync(to).size;
}

/* 图标（装到手机桌面要用） */
const iconSrc = path.join(ROOT, 'web', 'icons');
if (fs.existsSync(iconSrc)) {
  fs.cpSync(iconSrc, path.join(stage, 'web', 'icons'), { recursive: true });
}

/* ---- 第 3 步：单文件版放到包里最显眼的位置 ---- */
const single = path.join(DIST, '单文件版', '知时智农.html');
if (fs.existsSync(single)) {
  const target = path.join(stage, NAME + '-单文件版.html');
  fs.copyFileSync(single, target);
  total += fs.statSync(target).size;
  console.log('  + ' + (NAME + '-单文件版.html').padEnd(24) +
    (fs.statSync(target).size / 1024).toFixed(1) + ' KB  （双击即用）');
}

/* ---- 第 4 步：公网版整目录放进来 ---- */
const pubSrc = path.join(DIST, '公网版');
if (fs.existsSync(pubSrc)) {
  const pubDst = path.join(stage, '公网版');
  fs.mkdirSync(pubDst, { recursive: true });
  let pubSize = 0;
  for (const f of fs.readdirSync(pubSrc)) {
    const from = path.join(pubSrc, f);
    if (!fs.statSync(from).isFile()) {
      // icons/ 这类目录要整目录带过去，否则手机上装出来的图标是空的
      if (f === 'icons' || f === 'screenshots') {
        fs.cpSync(from, path.join(pubDst, f), { recursive: true });
      }
      continue;
    }
    // index.html.single 是给托管平台用的单文件，改个清楚的名字
    const name = f === 'index.html.single' ? '单页面版-index.html' : f;
    fs.copyFileSync(from, path.join(pubDst, name));
    pubSize += fs.statSync(from).size;
  }
  total += pubSize;
  console.log('  + 公网版/'.padEnd(24) + (pubSize / 1024).toFixed(0) + ' KB  （上传到托管平台）');
}

for (const [src, dst] of files) {
  const to = path.join(stage, dst);
  if (fs.existsSync(to)) {
    console.log('  + ' + dst.padEnd(24) + (fs.statSync(to).size / 1024).toFixed(1) + ' KB');
  }
}

console.log('\n  合计 ' + (total / 1024).toFixed(0) + ' KB');

/* ---- 第 5 步：压缩 ---- */
const zipPath = path.join(DIST, NAME + '.zip');
fs.rmSync(zipPath, { force: true });
try {
  execSync(
    `powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; ` +
    `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'pipe' }
  );
  console.log('  ZIP: ' + zipPath);
  console.log('  大小: ' + (fs.statSync(zipPath).size / 1024).toFixed(0) + ' KB');
} catch (e) {
  console.log('  压缩失败（可手动压缩 dist/' + NAME + ' 文件夹）');
}

/* ---- 第 6 步：自检 ---- */
console.log('\n=== 2. 包内自检 ===');
const need = [
  '使用说明.txt', 'start.bat',
  '知时智农-单文件版.html',
  'web/index.html', 'web/config.js', 'web/llm.js', 'web/weather.js',
  'web/hebei-geo.js', 'web/place.js', 'web/logic.js', 'web/ensemble.js', 'web/app.js',
  'web/pwa.js', 'web/sw.js', 'web/manifest.webmanifest', 'web/icons/icon-512.png',
  'web/server.mjs', 'web/qr.mjs',
  '公网版/index.html', '公网版/config.js', '公网版/部署说明.txt', '公网版/qr.mjs',
  '公网版/manifest.webmanifest', '公网版/icons/icon-512.png'
];
let ok = true;
for (const f of need) {
  const exists = fs.existsSync(path.join(stage, f));
  console.log('  ' + (exists ? 'OK  ' : '缺失 ') + f);
  if (!exists) ok = false;
}

/* 安全自检：公网版不能带 DeepSeek key */
const pubCfg = path.join(stage, '公网版', 'config.js');
if (fs.existsSync(pubCfg)) {
  const c = fs.readFileSync(pubCfg, 'utf8');
  const leaked = /sk-[a-f0-9]{20,}/.test(c);
  console.log('  ' + (leaked ? '危险 ' : 'OK  ') + '公网版不含 DeepSeek key');
  if (leaked) ok = false;
}

/* 安全自检：整个交付包里都不应出现按量计费的 DeepSeek key。
   本地版想开 AI 请用 web/config.local.js（不进包、不进仓库）。 */
const localCfg = path.join(stage, 'web', 'config.js');
if (fs.existsSync(localCfg)) {
  const c = fs.readFileSync(localCfg, 'utf8');
  const has = /sk-[a-f0-9]{20,}/.test(c);
  console.log('  ' + (has ? '危险 ' : 'OK  ') + '本地版不含 DeepSeek key');
  if (has) ok = false;
}
if (fs.existsSync(path.join(stage, 'web', 'config.local.js'))) {
  console.log('  危险 包内混入了 config.local.js（含私有 key）');
  ok = false;
}

console.log(ok ? '\n  ✔ 文件齐全' : '\n  ✘ 有文件缺失！');
process.exit(ok ? 0 : 1);
