/**
 * build-public.mjs — 生成可公网托管的版本
 * -------------------------------------------------------------
 * 为什么要单独出一个公网版：
 *   本地版把自己的 API Key 写在 config.js 里，小范围传阅没问题。
 *   但一旦上传到 GitHub Pages / Vercel 这类静态托管，源码对全网可见，
 *   key 就等于公开了。三把 key 的风险等级完全不同：
 *
 *     deepseekKey   ✗ 按量计费，被盗刷是真的会扣钱 → 公网版必须移除
 *     qweatherKey   △ 免费额度，被盗刷只是当日额度耗尽 → 保留，可换
 *     amapKey       ○ 有域名白名单机制，可以在控制台绑定域名 → 保留 + 提示
 *
 * 关键前提：移除 DeepSeek 不影响产品可用性。
 *   因为所有数字都由确定性规则引擎算出，大模型只做两件事：
 *     (1) 规则看不懂时的意图分类   (2) 把答案改写得更口语
 *   两者失效时都会静默回退到模板答案，结论完全一致。
 *   这正好也印证了"不依赖大模型编数字"的设计主张。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'dist', '公网版');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log('=== 生成公网版 ===\n');

/* ---- 1. 读取 config.js 并做安全处理 ---- */
let cfg = fs.readFileSync(path.join(WEB, 'config.js'), 'utf8');

// 移除 DeepSeek key（保持字段存在但为空，代码逻辑不用改）
cfg = cfg.replace(
  /deepseekKey:\s*'[^']*'/,
  "deepseekKey: ''"
);
// 公网版默认关闭大模型
cfg = cfg.replace(
  /enableLLM:\s*true/,
  'enableLLM: false'
);

// 替换头部说明
cfg = cfg.replace(
  /\/\* =============================================================\n   知时智农 · 本地配置[\s\S]*?\*\/\nwindow\.TIANZHI_CONFIG = \{/,
  `/* =============================================================
   知时智农 · 公网版配置
   -------------------------------------------------------------
   此版本用于上传到静态托管（GitHub Pages / Vercel 等），源码公开可见，
   因此做了以下安全处理：

   1) 已移除 DeepSeek API Key（enableLLM = false）
      大模型按量计费，公网暴露会被盗刷。移除后 AI 问答自动退回
      「确定性规则引擎」模式，所有结论、数字、窗口完全不变，
      只是少了口语化改写。这也正好演示了本作品的核心理念：
      数字不依赖大模型生成。

   2) 保留和风天气 key（免费额度，风险可接受）
      如需彻底关闭，把 enableQWeather 改成 false。

   3) 高德地图 key 建议在控制台绑定你的托管域名
      https://console.amap.com → 应用管理 → 设置域名白名单
      否则可能被他人引用。

   4) 想恢复 AI 能力：填入自己的 deepseekKey，并把 enableLLM 改为 true。
   ============================================================= */
window.TIANZHI_CONFIG = {`
);

console.log('  1. DeepSeek key 已移除: ' + (cfg.includes("deepseekKey: ''") ? 'OK' : 'FAIL'));
console.log('  2. 大模型默认关闭: ' + (cfg.includes('enableLLM: false') ? 'OK' : 'FAIL'));

/* ---- 2. 复制其余文件 ---- */
const files = ['index.html', 'llm.js', 'weather.js', 'hebei-geo.js',
               'logic.js', 'ensemble.js', 'app.js', 'server.mjs', 'qr.mjs',
               /* PWA：装到手机桌面需要这三个 + icons/ */
               'pwa.js', 'sw.js', 'manifest.webmanifest'];
for (const f of files) {
  fs.copyFileSync(path.join(WEB, f), path.join(OUT, f));
}
fs.writeFileSync(path.join(OUT, 'config.js'), cfg, 'utf8');

/* 图标与安装引导截图 */
fs.cpSync(path.join(WEB, 'icons'), path.join(OUT, 'icons'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
for (const f of ['01-desktop-overview.png', '12-mobile-iphone.png']) {
  const from = path.join(ROOT, 'screenshots', f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(OUT, 'screenshots', f));
}
console.log('  3. 复制 ' + (files.length + 1) + ' 个文件 + icons/ + screenshots/');

/* ---- 3. 生成单文件版（公网版也出单文件，方便直接拖到托管平台）---- */
let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

/* 先摘掉本地私有配置那一行：
   单文件版会把每个 <script src> 就地展开内联，而 config.local.js
   里就是 DeepSeek key。不先删掉，它会被原样写进 index.html.single。 */
html = html.replace(/\s*<!-- 本地私有配置[^\n]*\n\s*<script src="config\.local\.js"><\/script>/, '')
           .replace(/\s*<script src="config\.local\.js"><\/script>/, '');

const re = /<script\s+src="([^"]+)"\s*><\/script>/g;
const found = [];
let m;
while ((m = re.exec(html)) !== null) found.push({ full: m[0], src: m[1], index: m.index });

for (let i = found.length - 1; i >= 0; i--) {
  const f = found[i];
  let code;
  if (f.src === 'config.js') {
    code = cfg;
  } else {
    code = fs.readFileSync(path.join(WEB, f.src), 'utf8');
  }
  code = code.replace(/<\/script/gi, '<\\/script');
  const tag = '<!-- ' + f.src + ' -->\n<script>\n' + code + '\n</script>';
  html = html.slice(0, f.index) + tag + html.slice(f.index + f.full.length);
}
fs.writeFileSync(path.join(OUT, 'index.html.single'), html, 'utf8');
console.log('  4. 单文件版（公网配置）: index.html.single');

/* ---- 4. 生成部署说明 ---- */
const guide = `知时智农 · 公网部署说明
================================================

【这个文件夹是什么】
  已经做好安全处理的版本，可以直接上传到静态托管平台，
  让任何人通过网址打开（手机、电脑都行）。

【和本地版的区别】
  已移除 DeepSeek API Key。AI 问答会自动退回「确定性规则引擎」，
  所有天气判断、打药窗口、置信度、反事实推演完全不变。
  理由：大模型按量计费，公网暴露会被盗刷。

【部署方式一：GitHub Pages（免费，最简单）】
  1. 注册 github.com，新建一个仓库（Public）
  2. 把本文件夹里所有文件上传到仓库根目录
  3. 仓库 Settings → Pages → Source 选 main 分支 / root → Save
  4. 等 1 分钟，访问 https://你的用户名.github.io/仓库名/
  注意：用 index.html（多文件版）而不是 index.html.single

【部署方式二：Vercel（免费，速度更快）】
  1. 注册 vercel.com
  2. 首页 New Project → 选你的 GitHub 仓库 → Deploy
  3. 完成后得到 https://xxx.vercel.app 地址

【部署方式三：Netlify Drop（最快，30 秒，不用注册仓库）】
  1. 打开 app.netlify.com/drop
  2. 把整个文件夹拖进去
  3. 立刻得到网址

【手机访问】
  部署完成后，把网址发到手机浏览器打开即可。
  界面会自动切换为手机排版：侧栏收起为抽屉、按钮放大、
  图表可左右滑动。

【安全提醒 · 请务必看完】
  1) 高德地图 key：建议去 console.amap.com 绑定你的域名，
     否则可能被他人引用。绑定后只有你的域名能用这把 key。
  2) 和风天气 key：免费额度，如果被刷爆，去控制台换一把新的，
     改 config.js 里的 qweatherKey 即可。
  3) 想恢复 AI 增强：填入自己的 DeepSeek key 并把 enableLLM 改为 true。

【一个诚实的说明】
  公网版关掉了大模型，但这不是"降级"——本作品的所有结论本来就
  由规则引擎算出，大模型只负责把话说顺。关掉它，答案的数字和
  结论完全一致，只是措辞更朴素。这恰恰说明了设计的可靠性。

================================================
知时智农 · 河北农业大学首届大学生人工智能素养大赛
`;

fs.writeFileSync(path.join(OUT, '部署说明.txt'), guide, 'utf8');
console.log('  5. 部署说明.txt');

/* ---- 5. 自检 ---- */
console.log('\n=== 自检 ===');
const outCfg = fs.readFileSync(path.join(OUT, 'config.js'), 'utf8');
const outHtml = fs.readFileSync(path.join(OUT, 'index.html.single'), 'utf8');
const checks = [
  ['config 无 DeepSeek key', !/sk-[a-f0-9]{20,}/.test(outCfg)],
  ['config 关闭 LLM', outCfg.includes('enableLLM: false')],
  ['单文件版也无 DeepSeek key', !/sk-[a-f0-9]{20,}/.test(outHtml)],
  ['单文件版未内联 config.local.js', !/<script src="config\.local\.js"/.test(outHtml)],
  ['保留高德 key', outCfg.includes('948cc31be84ca8439eef646a5a2a5281')],
  ['保留和风 host', outCfg.includes('qweatherapi.com')],
  ['index.html 存在', fs.existsSync(path.join(OUT, 'index.html'))],
  ['PWA: manifest 存在', fs.existsSync(path.join(OUT, 'manifest.webmanifest'))],
  ['PWA: sw.js 存在', fs.existsSync(path.join(OUT, 'sw.js'))],
  ['PWA: pwa.js 存在', fs.existsSync(path.join(OUT, 'pwa.js'))],
  ['PWA: 图标存在', fs.existsSync(path.join(OUT, 'icons', 'icon-512.png'))],
  ['部署说明存在', fs.existsSync(path.join(OUT, '部署说明.txt'))]
];
let ok = true;
for (const [n, p] of checks) {
  console.log('  ' + (p ? 'OK  ' : 'FAIL ') + n);
  if (!p) ok = false;
}

console.log('\n产物目录: ' + OUT);
process.exit(ok ? 0 : 1);
