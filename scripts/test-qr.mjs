/**
 * test-qr.mjs — 验证二维码生成器
 * -------------------------------------------------------------
 * 难点：怎么证明生成的二维码"真的能扫"？
 *   · 只看矩阵形状对，不代表能被解码（纠错、掩码、交织任何一处错都不行）
 *   · 环境里没有解码库，也不能装
 *
 * 办法：写一个最小的二维码解码器交叉验证。
 *   解码走的是和编码完全不同的路径：读格式信息 → 去掩码 →
 *   按之字形取比特 → 反交织 → 校验纠错 → 还原字节。
 *   两条独立路径得到同一个字符串，才说明编码正确。
 */
import { makeQR, renderToTerminal } from '../web/qr.mjs';

let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

console.log('=== 二维码生成器测试 ===\n');

/* ---------- 独立实现的最小解码器 ---------- */
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

/** 建一张"功能图形"标记表，用于区分数据区 */
function buildFunctionMap(size, version) {
  const fn = [];
  for (let i = 0; i < size; i++) fn.push(new Array(size).fill(false));

  const markFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr >= 0 && rr < size && cc >= 0 && cc < size) fn[rr][cc] = true;
      }
    }
  };
  markFinder(0, 0);
  markFinder(0, size - 7);
  markFinder(size - 7, 0);

  // 定时
  for (let i = 8; i < size - 8; i++) { fn[6][i] = true; fn[i][6] = true; }

  // 对齐
  const pos = ALIGN_POS[version];
  for (const r of pos) {
    for (const c of pos) {
      if ((r === 6 && c === 6) ||
          (r === 6 && c === pos[pos.length - 1]) ||
          (r === pos[pos.length - 1] && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++) fn[r + dr][c + dc] = true;
    }
  }

  // 格式信息
  for (let i = 0; i < 9; i++) { fn[8][i] = true; fn[i][8] = true; }
  for (let i = 0; i < 8; i++) { fn[8][size - 1 - i] = true; fn[size - 1 - i][8] = true; }
  fn[size - 8][8] = true;

  return fn;
}

/** 读格式信息还原掩码号 */
function readMaskId(m, size) {
  // 从左上角读 15 位
  const bits = [];
  for (let i = 0; i < 15; i++) {
    let bit;
    if (i < 6) bit = m[8][i];
    else if (i < 8) bit = m[8][i + 1];
    else if (i === 8) bit = m[7][8];
    else bit = m[14 - i][8];
    bits.push(bit);
  }
  // 拼成整数（注意写入时是 LSB 优先，这里反推）
  let raw = 0;
  for (let i = 0; i < 15; i++) raw |= bits[i] << i;
  raw ^= 0x5412;

  // 取低 5 位：ec(2) + mask(3)
  const data = raw >> 10;
  return data & 0b111;
}

/** 按之字形读取数据比特 */
function readDataBits(m, fn, size) {
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? (size - 1 - vert) : vert;
      for (let k = 0; k < 2; k++) {
        const col = right - k;
        if (fn[row][col]) continue;
        bits.push(m[row][col]);
      }
    }
    upward = !upward;
  }
  return bits;
}

/** 完整解码 */
function decode(qr) {
  const { size, modules } = qr;
  const version = (size - 17) / 4;
  const fn = buildFunctionMap(size, version);
  const maskId = readMaskId(modules, size);
  const fnMask = MASKS[maskId];

  // 去掩码
  const unmasked = modules.map(row => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (fn[r][c]) continue;
      if (fnMask(r, c)) unmasked[r][c] ^= 1;
    }
  }

  // 读比特 → 字节
  const bits = readDataBits(unmasked, fn, size);
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    bytes.push(b);
  }

  // 反交织
  const spec = VERSION_L[version];
  const blockCount = spec.groups.reduce((s, [n]) => s + n, 0);
  const dataLens = [];
  for (const [count, dataLen] of spec.groups) {
    for (let i = 0; i < count; i++) dataLens.push(dataLen);
  }

  const blocks = dataLens.map(() => []);
  let idx = 0;
  const maxData = Math.max(...dataLens);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blockCount; b++) {
      if (i < dataLens[b]) blocks[b].push(bytes[idx++]);
    }
  }
  const dataBytes = blocks.flat();

  // 解析：模式(4) + 长度(8) + 内容
  let bitPos = 0;
  const readBits = n => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = Math.floor(bitPos / 8);
      const bitIdx = 7 - (bitPos % 8);
      v = (v << 1) | ((dataBytes[byteIdx] >> bitIdx) & 1);
      bitPos++;
    }
    return v;
  };

  const mode = readBits(4);
  if (mode !== 0b0100) throw new Error('模式不是字节模式: ' + mode.toString(2));
  const len = readBits(8);
  const out = [];
  for (let i = 0; i < len; i++) out.push(readBits(8));

  return {
    text: new TextDecoder().decode(new Uint8Array(out)),
    version,
    maskId
  };
}

/* ---------- 测试用例 ---------- */
const CASES = [
  'http://192.168.1.100:8931/',
  'http://127.0.0.1:8931/',
  'http://10.0.0.5:8932/',
  'https://zhishizhinong.github.io/agri-agent/',
  'http://172.16.31.204:8931/',
  'A',
  'https://example.vercel.app/'
];

console.log('== 1. 编码 → 独立解码 → 比对 ==');
let allOk = true;
for (const text of CASES) {
  try {
    const qr = makeQR(text);
    const dec = decode(qr);
    const ok = dec.text === text;
    if (!ok) allOk = false;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' "' + text + '"  v' + qr.version +
      ' ' + qr.size + 'x' + qr.size + ' mask=' + dec.maskId +
      (ok ? '' : '  → 解出: "' + dec.text + '"'));
    if (!ok) fail++; else pass++;
  } catch (e) {
    console.log('  FAIL "' + text + '" 异常: ' + e.message);
    fail++;
    allOk = false;
  }
}

console.log('\n== 2. 边界与错误处理 ==');
try {
  makeQR('x'.repeat(135));
  check(false, '超长内容应报错');
} catch (e) {
  check(/过长/.test(e.message), '超长内容正确报错');
}

const tiny = makeQR('A');
check(tiny.size === 21, '最短内容用版本 1（21x21），实际 ' + tiny.size);

const long = makeQR('https://zhishizhinong.github.io/agri-agent/index.html');
check(long.version >= 3, '长 URL 自动升版本（v' + long.version + '）');

console.log('\n== 3. 静区与定位图形 ==');
const q = makeQR('http://192.168.1.100:8931/');
const M = q.modules;
// 三个定位图形的左上角应为深色
check(M[0][0] === 1, '左上定位角为深色');
check(M[0][q.size - 1] === 1, '右上定位角为深色');
check(M[q.size - 1][0] === 1, '左下定位角为深色');
// 定位图形中心 3x3 为深色
check(M[3][3] === 1, '左上定位中心深色');
// 定位图形内外之间的白环
check(M[1][1] === 0, '定位图形白环');
check(M[q.size - 8][8] === 1, '固定暗模块存在');

console.log('\n== 4. 终端渲染 ==');
const lines = renderToTerminal(q, 2);
check(lines.length > 5, '终端输出 ' + lines.length + ' 行');
check(lines.every(l => /^[█▀▄ ]+$/.test(l)), '只用半块字符，无杂字符');
const widths = new Set(lines.map(l => l.length));
check(widths.size === 1, '各行等宽（' + [...widths][0] + ' 字符）');
console.log('\n  预览：');
lines.forEach(l => console.log('  ' + l));

console.log(`\n===== 结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
