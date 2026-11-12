/**
 * build-single.mjs — 把整个应用打成单个 index.html
 * -------------------------------------------------------------
 * 为什么需要：
 *   发给同学/评委时，一个 html 文件双击就开，不用管 7 个 js 文件
 *   有没有一起拷过去、有没有少一个。这是最不容易出错的交付方式。
 *
 * 做法：
 *   按 index.html 里的 <script src> 顺序把每个文件内联成 <script>，
 *   CSS 本来就在 <style> 里，无需处理。
 *
 * 注意事项：
 *   · 内联脚本里不能出现 </script> 字面量，否则提前闭合——要转义
 *   · 保持原有顺序，logic.js 必须在 ensemble.js/app.js 之前
 *   · hebei-geo.js 体积最大（离线地图边界），单文件会到 340KB 左右
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..', 'web');
const OUT_DIR = path.resolve(HERE, '..', 'dist', '单文件版');

let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

/* ---- 先摘掉「本地私有配置」那一行 ----
   单文件版是要发给别人的，而 config.local.js 里放的是按量计费的
   DeepSeek key。它必须在内联之前就被去掉，否则会原样写进产出的 html，
   谁拿到这个文件谁就能刷你的额度。 */
const localCfgTag = /\s*<!-- 本地私有配置[^\n]*\n\s*<script src="config\.local\.js"><\/script>/;
if (localCfgTag.test(html)) {
  html = html.replace(localCfgTag, '');
  console.log('=== 已移除本地私有配置引用（config.local.js）===\n');
} else {
  html = html.replace(/\s*<script src="config\.local\.js"><\/script>/, '');
}

/* ---- 找出所有 <script src="x.js"></script> ---- */
const re = /<script\s+src="([^"]+)"\s*><\/script>/g;
const found = [];
let m;
while ((m = re.exec(html)) !== null) {
  found.push({ full: m[0], src: m[1], index: m.index });
}

if (!found.length) {
  console.error('没有找到外链脚本，检查 index.html');
  process.exit(1);
}

console.log('=== 内联脚本 ===');

// 从后往前替换，避免索引错位
let totalInlined = 0;
for (let i = found.length - 1; i >= 0; i--) {
  const f = found[i];
  const file = path.join(WEB, f.src);
  if (!fs.existsSync(file)) {
    console.error('  缺失: ' + f.src);
    process.exit(1);
  }
  let code = fs.readFileSync(file, 'utf8');

  // 关键：脚本里若出现 </script 会提前闭合标签，必须打断
  code = code.replace(/<\/script/gi, '<\\/script');

  const size = Buffer.byteLength(code, 'utf8');
  totalInlined += size;

  const tag = '<!-- ' + f.src + ' (' + (size / 1024).toFixed(1) + ' KB) -->\n' +
              '<script>\n' + code + '\n</script>';
  html = html.slice(0, f.index) + tag + html.slice(f.index + f.full.length);

  console.log('  ' + f.src.padEnd(18) + (size / 1024).toFixed(1) + ' KB');
}

/* ---- 写入 ---- */
fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, '知时智农.html');
fs.writeFileSync(outFile, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log('\n=== 产物 ===');
console.log('  ' + outFile);
console.log('  ' + kb + ' KB');

/* ---- 自检 ----
   注意两点：
     1. 判断"有无残留外链"不能简单搜 <script src=，因为 logic.js 的
        注释里就写着「<script src="logic.js"> 后通过 window.TianZhi 访问」。
     2. 各模块用 UMD 挂载，写法是 root.TianZhi = api（root 即 globalThis），
        不是 window.TianZhi = ...，正则要按实际写法匹配。
   最终判据还是浏览器真实加载，见 test-single.mjs。 */
console.log('\n=== 自检 ===');
const realSrcTags = (html.match(/<script\s+src="[^"]+\.js"\s*><\/script>/g) || []);
const checks = [
  ['无残留外链 script 标签', realSrcTags.length === 0],
  ['逻辑层挂载 TianZhi', /root\.TianZhi\s*=/.test(html)],
  ['集合层挂载 TianZhiEnsemble', /root\.TianZhiEnsemble\s*=/.test(html)],
  ['气象层挂载 TianZhiWeather', /root\.TianZhiWeather\s*=/.test(html)],
  ['LLM 层挂载 TianZhiLLM', /root\.TianZhiLLM\s*=/.test(html)],
  ['配置 TIANZHI_CONFIG', /TIANZHI_CONFIG\s*=/.test(html)],
  ['河北边界数据', /hebeiGeojson|Hebeig?eojson|河北/.test(html)],
  ['高德地图 key', html.includes('948cc31be84ca8439eef646a5a2a5281')],
  ['不含 DeepSeek key', !/sk-[a-zA-Z0-9]{20,}/.test(html)],
  ['script 开闭标签配对', (html.match(/<script>/g) || []).length === (html.match(/<\/script>/g) || []).length],
  ['无未转义的 </script', (html.match(/<\/script/gi) || []).length === (html.match(/<\/script>/g) || []).length],
  ['品牌名', html.includes('知时智农')]
];
let ok = true;
for (const [name, pass] of checks) {
  console.log('  ' + (pass ? 'OK  ' : 'FAIL ') + name);
  if (!pass) ok = false;
}
if (realSrcTags.length) console.log('    残留: ' + realSrcTags.join(', '));

const blocks = html.match(/<script>\n([\s\S]*?)\n<\/script>/g) || [];
console.log('\n  内联脚本块: ' + blocks.length + ' 个');

console.log('\n下一步：用 node test-single.mjs 在浏览器里真实加载验证');

process.exit(ok ? 0 : 1);
