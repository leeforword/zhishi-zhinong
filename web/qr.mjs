/**
 * qr.mjs — 极简二维码生成器（零依赖）
 * -------------------------------------------------------------
 * 为什么自己写：
 *   整个项目坚持零依赖（不 npm install 就能跑），而扫码入口需要一个
 *   能生成二维码的东西。引入 qrcode 之类的包会破坏这个前提。
 *
 * 实现范围（刻意收窄，够用即可）：
 *   · 字节模式（URL 全是 ASCII，不需要汉字编码）
 *   · 纠错等级 L（容量最大，终端显示清晰度足够）
 *   · 版本 1–6（v6-L 能装 134 字节，任何局域网地址都够）
 *     → 不到版本 7 就不用写版本信息码，少一大块复杂度
 *
 * 输出：{ size, modules }，modules 是 size×size 的 0/1 二维数组
 * ============================================================= */

/* 版本参数表（纠错等级 L）
   [每块纠错码字数, [块数, 每块数据码字数] 的组] */
const VERSION_L = {
  1:  { ecPerBlock: 7,  groups: [[1, 19]] },
  2:  { ecPerBlock: 10, groups: [[1, 34]] },
  3:  { ecPerBlock: 15, groups: [[1, 55]] },
  4:  { ecPerBlock: 20, groups: [[1, 80]] },
  5:  { ecPerBlock: 26, groups: [[1, 108]] },
  6:  { ecPerBlock: 18, groups: [[2, 68]] }
};

/* 对齐图形中心坐标（v1 没有） */
const ALIGN_POS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34]
};

/* 数据容量（字节），版本 1–6 / L */
const CAPACITY = { 1: 17, 2: 32, 3: 53, 4: 78, 5: 106, 6: 134 };

/* -------------------------------------------------------------
   GF(256) 运算，用于 Reed-Solomon
   ------------------------------------------------------------- */
const EXP = new Array(512);
const LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;   // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成 degree 次的 Reed-Solomon 生成多项式 */
function rsGenPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    // 乘 (x - α^i)
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 计算 data 的 RS 纠错码 */
function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) {
        res[i] ^= gfMul(gen[i + 1], factor);
      }
    }
  }
  return res;
}

/* -------------------------------------------------------------
   主流程
   ------------------------------------------------------------- */

/** 选一个装得下的最小版本 */
function pickVersion(byteLen) {
  for (let v = 1; v <= 6; v++) {
    if (byteLen <= CAPACITY[v]) return v;
  }
  throw new Error('内容过长（最多 ' + CAPACITY[6] + ' 字节）: ' + byteLen);
}

/** 编码成比特流 → 数据码字 */
function encodeData(text, version) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const bits = [];

  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  push(0b0100, 4);              // 字节模式
  push(bytes.length, 8);        // 字符数（v1–9 固定 8 位）
  for (const b of bytes) push(b, 8);

  // 终止符
  const totalDataBits = CAPACITY[version] * 8;
  const term = Math.min(4, totalDataBits - bits.length);
  push(0, term);

  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);

  // 转成字节
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }

  // 填充字节 0xEC / 0x11 交替
  const padBytes = [0xEC, 0x11];
  let k = 0;
  while (out.length < CAPACITY[version]) {
    out.push(padBytes[k % 2]);
    k++;
  }
  return out;
}

/** 分块 + 加纠错 + 交织 */
function interleave(dataBytes, version) {
  const spec = VERSION_L[version];
  const blocks = [];
  let offset = 0;
  for (const [count, dataLen] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const chunk = dataBytes.slice(offset, offset + dataLen);
      offset += dataLen;
      blocks.push({ data: chunk, ec: rsEncode(chunk, spec.ecPerBlock) });
    }
  }

  const result = [];
  // 先交织所有数据码字
  const maxData = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) {
      if (i < b.data.length) result.push(b.data[i]);
    }
  }
  // 再交织所有纠错码字
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const b of blocks) {
      result.push(b.ec[i]);
    }
  }
  return result;
}

/** 创建空白矩阵 */
function newMatrix(size) {
  const m = [];
  for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));
  return m;
}

/** 放三个定位图形（含分隔符） */
function placeFinder(m, row, col) {
  const size = m.length;
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r, cc = col + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const inOuter = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                      (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[rr][cc] = (inOuter || inInner) ? 1 : 0;
    }
  }
}

/** 放对齐图形 */
function placeAlign(m, version) {
  const pos = ALIGN_POS[version];
  for (const r of pos) {
    for (const c of pos) {
      // 跳过与定位图形重叠的位置
      if ((r === 6 && c === 6) ||
          (r === 6 && c === pos[pos.length - 1]) ||
          (r === pos[pos.length - 1] && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isEdge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const isCenter = dr === 0 && dc === 0;
          m[r + dr][c + dc] = (isEdge || isCenter) ? 1 : 0;
        }
      }
    }
  }
}

/** 放定时图形 */
function placeTiming(m) {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    const v = (i % 2 === 0) ? 1 : 0;
    if (m[6][i] === null) m[6][i] = v;
    if (m[i][6] === null) m[i][6] = v;
  }
}

/** 保留格式信息区域（先占位，稍后写真实值） */
function reserveFormat(m) {
  const size = m.length;
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
  }
  m[size - 8][8] = 1;   // 固定的暗模块
}

/** 按之字形放置数据比特 */
function placeData(m, bits) {
  const size = m.length;
  let bitIdx = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;      // 跳过定时列
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? (size - 1 - vert) : vert;
      for (let k = 0; k < 2; k++) {
        const col = right - k;
        if (m[row][col] !== null) continue;
        m[row][col] = bitIdx < bits.length ? bits[bitIdx] : 0;
        bitIdx++;
      }
    }
    upward = !upward;
  }
  return bitIdx;
}

/** 8 种掩码 */
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

/** 格式信息：EC 等级 + 掩码号 → 15 位（BCH + 掩码常量） */
function formatInfo(maskId) {
  const ecBits = 0b01;                 // L 等级
  const data = (ecBits << 3) | maskId;

  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;
  return bits;
}

/** 写入格式信息到两个位置 */
function placeFormat(m, maskId) {
  const size = m.length;
  const bits = formatInfo(maskId);

  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;

    // 左上角
    if (i < 6) m[8][i] = bit;
    else if (i < 8) m[8][i + 1] = bit;
    else if (i === 8) m[7][8] = bit;
    else m[14 - i][8] = bit;

    // 右上 / 左下
    if (i < 8) m[size - 1 - i][8] = bit;
    else m[8][size - 15 + i] = bit;
  }
  m[size - 8][8] = 1;
}

/** 惩罚分：用于挑选最优掩码 */
function penalty(m) {
  const size = m.length;
  let score = 0;

  // 规则 1：连续同色
  for (let i = 0; i < size; i++) {
    for (const dir of [0, 1]) {
      let run = 1, prev = -1;
      for (let j = 0; j < size; j++) {
        const v = dir === 0 ? m[i][j] : m[j][i];
        if (v === prev) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; prev = v; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // 规则 2：2x2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // 规则 3：形如 1011101 0000 的图案
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (arr, pat) => pat.every((v, i) => arr[i] === v);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      const rowSeg = [], colSeg = [];
      for (let k = 0; k < 11; k++) {
        rowSeg.push(m[i][j + k]);
        colSeg.push(m[j + k][i]);
      }
      if (match(rowSeg, pat1) || match(rowSeg, pat2)) score += 40;
      if (match(colSeg, pat1) || match(colSeg, pat2)) score += 40;
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const ratio = dark / (size * size);
  score += Math.floor(Math.abs(ratio * 100 - 50) / 5) * 10;

  return score;
}

/** 深拷贝矩阵 */
function clone(m) {
  return m.map(row => row.slice());
}

/**
 * 生成二维码
 * @param {string} text
 * @returns {{size:number, modules:number[][]}}
 */
export function makeQR(text) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const size = 17 + version * 4;

  const dataBytes = encodeData(text, version);
  const finalBytes = interleave(dataBytes, version);

  // 转比特流
  const bits = [];
  for (const b of finalBytes) {
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  }

  // 基础矩阵（功能图形）
  const base = newMatrix(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeAlign(base, version);
  placeTiming(base);
  reserveFormat(base);

  // 放数据
  const filled = clone(base);
  placeData(filled, bits);

  // 试 8 种掩码，选惩罚分最低的
  let best = null, bestScore = Infinity;
  for (let maskId = 0; maskId < 8; maskId++) {
    const m = clone(filled);
    const fn = MASKS[maskId];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        // 只对数据区做掩码（功能图形不动）
        if (base[r][c] !== null) continue;
        if (fn(r, c)) m[r][c] ^= 1;
      }
    }
    placeFormat(m, maskId);
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; best = m; }
  }

  return { size, modules: best, version };
}

/**
 * 把二维码渲染成终端文本（用半块字符，纵向压缩一半）
 * @param {{size:number, modules:number[][]}} qr
 * @param {number} quiet 静区宽度（模块数，建议 2）
 */
export function renderToTerminal(qr, quiet = 2) {
  const { size, modules } = qr;
  const total = size + quiet * 2;

  const get = (r, c) => {
    const rr = r - quiet, cc = c - quiet;
    if (rr < 0 || rr >= size || cc < 0 || cc >= size) return 0;
    return modules[rr][cc];
  };

  const lines = [];
  for (let r = 0; r < total; r += 2) {
    let line = '';
    for (let c = 0; c < total; c++) {
      const top = get(r, c);
      const bottom = get(r + 1, c);
      if (top && bottom) line += '█';
      else if (top) line += '▀';
      else if (bottom) line += '▄';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines;
}

/**
 * 渲染成 SVG —— 比终端可靠得多
 * -------------------------------------------------------------
 * 终端里的二维码能不能扫，取决于字体宽高比是否正好 2:1。
 * Windows 的 cmd.exe 不保证这一点，经常扫不出来。
 * 用浏览器打开 SVG 就没有这个问题：每个模块都是正方形。
 *
 * @param {{size:number, modules:number[][]}} qr
 * @param {number} moduleSize 每个模块的像素数
 * @param {number} quiet 静区模块数（规范要求 ≥4）
 */
export function renderToSVG(qr, moduleSize = 8, quiet = 4) {
  const { size, modules } = qr;
  const total = size + quiet * 2;
  const px = total * moduleSize;

  // 把相邻深色模块合并成矩形，减少 SVG 体积
  let rects = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!modules[r][c]) { c++; continue; }
      let len = 0;
      while (c + len < size && modules[r][c + len]) len++;
      rects += '<rect x="' + ((c + quiet) * moduleSize) +
               '" y="' + ((r + quiet) * moduleSize) +
               '" width="' + (len * moduleSize) +
               '" height="' + moduleSize + '"/>';
      c += len;
    }
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" ' +
         'viewBox="0 0 ' + px + ' ' + px + '" shape-rendering="crispEdges">' +
         '<rect width="' + px + '" height="' + px + '" fill="#fff"/>' +
         '<g fill="#000">' + rects + '</g>' +
         '</svg>';
}

