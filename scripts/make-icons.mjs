/**
 * make-icons.mjs — 生成 App 图标（零依赖，纯 Node）
 * -------------------------------------------------------------
 * 为什么自己写 PNG 编码器：
 *   项目从第一天起就是「零第三方依赖」，为了几个图标去装 sharp /
 *   canvas 会打破这条原则，而且装依赖在别人的电脑上经常失败。
 *   PNG 的结构其实很简单（签名 + IHDR + IDAT + IEND），
 *   Node 内置 zlib 就能压缩，所以这里手写了一个约 60 行的编码器。
 *
* 图形设计（v6.2 定名「知时智农」）：
 *   底：亮翡翠 → 深翡翠的对角渐变（呼应品牌主色 #0E6B4A / 深色 #0A4F37）
 *   标：白色「窗」框 + 十字格 + 左上格**一轮日出与地平线**——
 *       「窗」是产品核心（那一小段时间窗口），日出＝看天时下地，
 *       比原来那滴药液更能覆盖打药 / 灌溉 / 晾晒三件事。
 *
 * 变体：`--variant=sun|wheat|drop`（默认 sun）。换方向时不必改代码，
 *       生成到 web/icons-alt/ 对比即可：ICON_OUT=web/icons-alt node scripts/make-icons.mjs --variant=wheat
 *
 * 采样方式：
 *   4×4 超采样（每像素 16 个样本）做抗锯齿，不需要任何图形库。
 *
 * 产物（写入 web/icons/，构建时复制到 site/）：
 *   icon-192.png            普通图标（圆角，桌面/安卓通用）
 *   icon-512.png            同上，高分辨率
 *   icon-maskable-192.png   可裁切图标（满版 + 图形缩到安全区）
 *   icon-maskable-512.png
 *   apple-touch-icon.png    180×180，iOS 用（满版，圆角由 iOS 自己切）
 *   icon.svg                矢量版，浏览器标签页 favicon 用
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = process.env.ICON_OUT
  ? path.resolve(ROOT, process.env.ICON_OUT)
  : path.join(ROOT, 'web', 'icons');
const VARIANT = (process.argv.find((a) => a.startsWith('--variant=')) || '').split('=')[1] || 'sun';

/* ============================================================
   一、最小 PNG 编码器
   ============================================================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素数组 → PNG 文件内容 */
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                                   // 过滤器类型 0（None）
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 6 = RGBA
  ihdr[10] = 0;  // 压缩方式
  ihdr[11] = 0;  // 滤波方式
  ihdr[12] = 0;  // 隔行扫描
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ============================================================
   二、形状测试（单位坐标系 0..1）
   ============================================================ */

/** 圆角矩形内部？r 为圆角半径（占边长比例） */
function inRoundRect(u, v, r) {
  if (r <= 0) return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  const dx = Math.max(r - u, 0, u - (1 - r));
  const dy = Math.max(r - v, 0, v - (1 - r));
  return dx * dx + dy * dy <= r * r;
}

/** 旋转椭圆内部？ang 为弧度 */
function inEllipse(u, v, cx, cy, rx, ry, ang) {
  const s = Math.sin(-ang), c = Math.cos(-ang);
  const px = u - cx, py = v - cy;
  const x = px * c - py * s;
  const y = px * s + py * c;
  return (x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1;
}

/** 圆头线段（胶囊）内部？用于画茎 */
function inCapsule(u, v, x1, y1, x2, y2, rad) {
  const ax = x2 - x1, ay = y2 - y1;
  const px = u - x1, py = v - y1;
  const len2 = ax * ax + ay * ay || 1;
  let t = (px * ax + py * ay) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - ax * t, dy = py - ay * t;
  return dx * dx + dy * dy <= rad * rad;
}

/* ============================================================
   三、配色
   ============================================================ */

const C_TOP = [31, 185, 138];   // 亮翡翠（上）
const C_BOT = [11, 79, 55];     // 深翡翠 #0A4F37（下）

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

/** 背景色：左上偏亮的对角渐变 */
function bgColor(u, v) {
  const t = Math.min(1, Math.max(0, v * 0.88 + u * 0.12));
  const base = mix(C_TOP, C_BOT, t);
  // 左上角加一点高光，避免整块渐变太平
  const d = Math.hypot(u - 0.12, v - 0.08);
  const lift = Math.max(0, 1 - d * 1.5) * 26;
  return [base[0] + lift, base[1] + lift * 0.6, base[2] + lift * 0.25];
}

/* ============================================================
   四、绘制
   ============================================================ */

const SS = 4;          // 超采样倍数
const SAMPLES = SS * SS;

/** 圆角矩形内部（显式边界版，用于画窗框） */
function rrBox(x, y, x0, y0, x1, y1, rad) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + rad - x, 0, x - (x1 - rad));
  const dy = Math.max(y0 + rad - y, 0, y - (y1 - rad));
  return dx * dx + dy * dy <= rad * rad;
}

/** 三角形内部（同侧法） */
function tri(px, py, ax, ay, bx, by, cx2, cy2) {
  const d1 = (px - bx) * (ay - by) - (py - by) * (ax - bx);
  const d2 = (px - cx2) * (by - cy2) - (py - cy2) * (bx - cx2);
  const d3 = (px - ax) * (cy2 - ay) - (py - ay) * (cx2 - ax);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

/** 水滴：以圆为体、尖角在上；三角底边正好落在圆的左右极点上 → 轮廓平滑无缝 */
function droplet(x, y, cx, ccy, R) {
  const body = Math.hypot(x - cx, y - ccy) <= R;
  const apexY = ccy - 1.9 * R;
  const tip = tri(x, y, cx, apexY, cx - R, ccy, cx + R, ccy);
  return body || tip;
}

/**
 * 「知时智农」图形（单位坐标），scale 用于缩到 maskable 安全区
 *   - 外框：圆角「窗」框（边框 + 十字格条）
 *   - 左上格：日出（太阳圆盘 + 地平线）
 *   - 变体 wheat：换成麦穗；drop：保留旧版药滴，便于回滚
 */
function inGlyph(u, v, scale) {
  const x = (u - 0.5) / scale + 0.5;
  const y = (v - 0.5) / scale + 0.5;

  const L = 0.16, R = 0.84, T = 0.16, B = 0.84; // 窗框外沿
  const rad = 0.16;                              // 外圆角
  const t = 0.085;                               // 边框厚度
  const bw = 0.062;                              // 十字格条宽度

  const outer = rrBox(x, y, L, T, R, B, rad);
  const inner = rrBox(x, y, L + t, T + t, R - t, B - t, rad * 0.55);
  const border = outer && !inner;

  const cx = (L + R) / 2, cy = (T + B) / 2;
  const vbar = outer && Math.abs(x - cx) <= bw / 2;
  const hbar = outer && Math.abs(y - cy) <= bw / 2;

  /* 左上格内部：x 0.245–0.469、y 0.245–0.469，图形别碰边框 */
  let mark = false;
  if (VARIANT === 'wheat') {
    mark = inCapsule(x, y, 0.357, 0.446, 0.357, 0.286, 0.010);
    for (let i = 0; i < 3; i++) {
      const gy = 0.300 + i * 0.044;
      mark = mark ||
        inEllipse(x, y, 0.335, gy, 0.026, 0.012, -0.62) ||
        inEllipse(x, y, 0.379, gy, 0.026, 0.012, 0.62);
    }
  } else if (VARIANT === 'drop') {
    mark = droplet(x, y, 0.345, 0.375, 0.055);
  } else {
    /* 日出：半个太阳压在地平线上（经典「日出」剪影）。
       用实心半圆 + 圆头横条，比「整圆 + 细线」在小尺寸下更不容易糊成一团。 */
    const barY = 0.386, R2 = 0.064;
    const dome = (y <= barY) && Math.hypot(x - 0.357, y - barY) <= R2;
    const bar = inCapsule(x, y, 0.297, barY, 0.417, barY, 0.011);
    mark = dome || bar;
  }

  return border || vbar || hbar || mark;
}

/**
 * @param {number} size     边长
 * @param {boolean} rounded 是否切圆角（false = 满版，给 maskable / iOS 用）
 * @param {number} glyphScale 图形缩放，maskable 要 <1 保证不被裁掉
 */
function drawIcon(size, rounded, glyphScale) {
  const out = Buffer.alloc(size * size * 4);
  const radius = rounded ? 0.224 : 0;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size;
          const v = (py + (sy + 0.5) / SS) / size;

          if (!inRoundRect(u, v, radius)) continue;   // 圆角外 → 透明

          let c;
          if (inGlyph(u, v, glyphScale)) {
            c = [255, 255, 255];
          } else {
            c = bgColor(u, v);
          }
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }

      const o = (py * size + px) * 4;
      // 用「有效样本数」平均颜色，用总样本数平均 alpha，边缘才不会发黑
      const hit = a / 255;
      if (hit > 0) {
        out[o] = Math.round(r / hit);
        out[o + 1] = Math.round(g / hit);
        out[o + 2] = Math.round(b / hit);
      }
      out[o + 3] = Math.round(a / SAMPLES);
    }
  }
  return encodePNG(size, size, out);
}

/* ============================================================
   五、矢量版（favicon.svg，浏览器标签页用）
   ============================================================ */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>知时智农</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#1FB98A"/>
      <stop offset="1" stop-color="#0A4F37"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="115" ry="115" fill="url(#bg)"/>
  <g fill="#ffffff" stroke="#ffffff">
    <rect x="82" y="82" width="348" height="348" rx="70" fill="none" stroke-width="44"/>
    <rect x="240" y="126" width="32" height="260" stroke="none"/>
    <rect x="126" y="240" width="260" height="32" stroke="none"/>
    ${VARIANT === 'wheat'
      ? '<rect x="177" y="146" width="11" height="82" rx="5.5" stroke="none"/>' +
        '<ellipse cx="166" cy="154" rx="13" ry="6" transform="rotate(-35 166 154)" stroke="none"/>' +
        '<ellipse cx="189" cy="154" rx="13" ry="6" transform="rotate(35 189 154)" stroke="none"/>' +
        '<ellipse cx="166" cy="176" rx="13" ry="6" transform="rotate(-35 166 176)" stroke="none"/>' +
        '<ellipse cx="189" cy="176" rx="13" ry="6" transform="rotate(35 189 176)" stroke="none"/>' +
        '<ellipse cx="166" cy="198" rx="13" ry="6" transform="rotate(-35 166 198)" stroke="none"/>' +
        '<ellipse cx="189" cy="198" rx="13" ry="6" transform="rotate(35 189 198)" stroke="none"/>'
      : VARIANT === 'drop'
        ? '<path stroke="none" d="M177 138.8 L149 192 A28 28 0 0 0 205 192 Z"/>'
        : '<path d="M150 198 A33 33 0 0 1 216 198 Z" stroke="none"/>' +
          '<rect x="152" y="192" width="62" height="12" rx="6" stroke="none"/>'}
  </g>
</svg>
`;

/* ============================================================
   六、产出
   ============================================================ */
fs.mkdirSync(OUT, { recursive: true });

const jobs = [
  ['icon-192.png', 192, true, 1],
  ['icon-512.png', 512, true, 1],
  // maskable：图形缩到 72%，落在 80% 安全圆内，任何形状的裁切都不会切到叶子
  ['icon-maskable-192.png', 192, false, 0.72],
  ['icon-maskable-512.png', 512, false, 0.72],
  // iOS 自己切圆角，这里必须满版
  ['apple-touch-icon.png', 180, false, 0.94]
];

console.log('=== 生成图标 ===\n');
for (const [name, size, rounded, scale] of jobs) {
  const png = drawIcon(size, rounded, scale);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`  ${name.padEnd(24)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

fs.writeFileSync(path.join(OUT, 'icon.svg'), SVG, 'utf8');
console.log(`  ${'icon.svg'.padEnd(24)} 矢量    ${(SVG.length / 1024).toFixed(1)} KB`);

console.log('\n输出目录: ' + OUT);
