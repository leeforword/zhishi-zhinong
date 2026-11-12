/**
 * test-qr-page.mjs — 验证 /qr 页面渲染出的二维码真的能被解析
 * -------------------------------------------------------------
 * 为什么要这一步：
 *   前面的 test-qr.mjs 只验证了"矩阵编码正确"。
 *   但从矩阵到 SVG 还有一次转换（相邻模块合并成 rect），
 *   这一步写错的话，屏幕上看着像二维码，实际扫不出来。
 *
 * 做法：把 SVG 里的 rect 还原回矩阵，再走解码器解出内容，
 *   和应该在二维码里的 URL 比对。这等价于扫码枪做的事。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8972;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const server = spawn(process.execPath, ['server.mjs', String(PORT), '--lan'], {
  cwd: path.join(ROOT, 'web'), stdio: 'ignore'
});
await sleep(1800);

console.log('=== /qr 页面二维码可解析性测试 ===\n');

let html = '';
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/qr`);
  html = await r.text();
  check(r.ok, '/qr 返回 200');
  check(html.includes('<svg'), '包含 SVG');
} catch (e) {
  console.log('  请求失败: ' + e.message);
  try { server.kill(); } catch (e2) { /* ignore */ }
  process.exit(1);
}

/* ---- 从页面里取出应该编码的 URL ---- */
const urlMatch = html.match(/class="url">([^<]+)</);
const expected = urlMatch ? urlMatch[1].trim() : '';
console.log('  期望内容: ' + expected);
check(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/$/.test(expected), 'URL 格式正确');

/* ---- 从 SVG 提取尺寸与 rect ---- */
const svgMatch = html.match(/<svg[^>]*width="(\d+)"[^>]*height="(\d+)"[^>]*viewBox="0 0 (\d+) (\d+)"/);
check(!!svgMatch, '取得 SVG 尺寸');
const px = svgMatch ? parseInt(svgMatch[1], 10) : 0;

const rects = [...html.matchAll(
  /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"\/>/g
)].map(m => ({
  x: parseInt(m[1], 10), y: parseInt(m[2], 10),
  w: parseInt(m[3], 10), h: parseInt(m[4], 10)
}));
console.log('  rect 数量: ' + rects.length);
check(rects.length > 20, '有足够多的图形单元');

/* ---- 推断模块大小（所有 rect 的 h 应当等于一个模块边长；静区 4）---- */
const moduleSize = Math.min(...rects.map(r => r.h));
const quiet = 4;
const size = px / moduleSize - quiet * 2;
console.log('  模块边长: ' + moduleSize + 'px');
console.log('  推断矩阵: ' + size + 'x' + size);
check(Number.isInteger(size) && size >= 21, '矩阵尺寸合法 (' + size + ')');

/* ---- 还原矩阵 ---- */
const M = [];
for (let i = 0; i < size; i++) M.push(new Array(size).fill(0));

for (const r of rects) {
  const row = r.y / moduleSize - quiet;
  const colStart = r.x / moduleSize - quiet;
  const len = r.w / moduleSize;
  const rows = r.h / moduleSize;
  for (let dr = 0; dr < rows; dr++) {
    for (let dc = 0; dc < len; dc++) {
      const rr = row + dr, cc = colStart + dc;
      if (rr >= 0 && rr < size && cc >= 0 && cc < size) M[rr][cc] = 1;
    }
  }
}

/* ---- 独立解码器（与 test-qr.mjs 同一套逻辑）---- */
const ALIGN_POS = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
const VERSION_L = {
  1: { ecPerBlock: 7, groups: [[1, 19]] },
  2: { ecPerBlock: 10, groups: [[1, 34]] },
  3: { ecPerBlock: 15, groups: [[1, 55]] },
  4: { ecPerBlock: 20, groups: [[1, 80]] },
  5: { ecPerBlock: 26, groups: [[1, 108]] },
  6: { ecPerBlock: 18, groups: [[2, 68]] }
};
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
  (r, c) => (((r * c) % 2 + (r * c) % 3) % 2) === 0,
  (r, c) => (((r + c) % 2 + (r * c) % 3) % 2) === 0
];

function buildFunctionMap(sz, version) {
  const fn = [];
  for (let i = 0; i < sz; i++) fn.push(new Array(sz).fill(false));
  const markFinder = (row, col) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr >= 0 && rr < sz && cc >= 0 && cc < sz) fn[rr][cc] = true;
      }
  };
  markFinder(0, 0); markFinder(0, sz - 7); markFinder(sz - 7, 0);
  for (let i = 8; i < sz - 8; i++) { fn[6][i] = true; fn[i][6] = true; }
  const pos = ALIGN_POS[version];
  for (const r of pos) for (const c of pos) {
    if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) ||
        (r === pos[pos.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++)
      for (let dc = -2; dc <= 2; dc++) fn[r + dr][c + dc] = true;
  }
  for (let i = 0; i < 9; i++) { fn[8][i] = true; fn[i][8] = true; }
  for (let i = 0; i < 8; i++) { fn[8][sz - 1 - i] = true; fn[sz - 1 - i][8] = true; }
  fn[sz - 8][8] = true;
  return fn;
}

function readMaskId(m, sz) {
  const bits = [];
  for (let i = 0; i < 15; i++) {
    let bit;
    if (i < 6) bit = m[8][i];
    else if (i < 8) bit = m[8][i + 1];
    else if (i === 8) bit = m[7][8];
    else bit = m[14 - i][8];
    bits.push(bit);
  }
  let raw = 0;
  for (let i = 0; i < 15; i++) raw |= bits[i] << i;
  raw ^= 0x5412;
  return (raw >> 10) & 0b111;
}

function decodeMatrix(m, sz) {
  const version = (sz - 17) / 4;
  const fn = buildFunctionMap(sz, version);
  const maskId = readMaskId(m, sz);
  const fnMask = MASKS[maskId];

  const un = m.map(row => row.slice());
  for (let r = 0; r < sz; r++)
    for (let c = 0; c < sz; c++) {
      if (fn[r][c]) continue;
      if (fnMask(r, c)) un[r][c] ^= 1;
    }

  const bits = [];
  let upward = true;
  for (let right = sz - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < sz; vert++) {
      const row = upward ? (sz - 1 - vert) : vert;
      for (let k = 0; k < 2; k++) {
        const col = right - k;
        if (fn[row][col]) continue;
        bits.push(un[row][col]);
      }
    }
    upward = !upward;
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    bytes.push(b);
  }

  const spec = VERSION_L[version];
  const blockCount = spec.groups.reduce((s, [n]) => s + n, 0);
  const dataLens = [];
  for (const [count, dataLen] of spec.groups)
    for (let i = 0; i < count; i++) dataLens.push(dataLen);

  const blocks = dataLens.map(() => []);
  let idx = 0;
  const maxData = Math.max(...dataLens);
  for (let i = 0; i < maxData; i++)
    for (let b = 0; b < blockCount; b++)
      if (i < dataLens[b]) blocks[b].push(bytes[idx++]);

  const data = blocks.flat();
  let bp = 0;
  const rb = n => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const bi = Math.floor(bp / 8), off = 7 - (bp % 8);
      v = (v << 1) | ((data[bi] >> off) & 1);
      bp++;
    }
    return v;
  };

  const mode = rb(4);
  if (mode !== 0b0100) throw new Error('非字节模式');
  const len = rb(8);
  const out = [];
  for (let i = 0; i < len; i++) out.push(rb(8));
  return new TextDecoder().decode(new Uint8Array(out));
}

console.log('\n== 从 SVG 还原并解码 ==');
try {
  const decoded = decodeMatrix(M, size);
  console.log('  解出内容: ' + decoded);
  check(decoded === expected, 'SVG 渲染的二维码可正确解码');
} catch (e) {
  check(false, '解码失败: ' + e.message);
}

try { server.kill(); } catch (e) { /* ignore */ }
await sleep(300);
console.log(`\n===== 结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
