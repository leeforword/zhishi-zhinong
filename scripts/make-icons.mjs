/**
 * make-icons.mjs — 生成 App 图标（零依赖，纯 Node）
 * -------------------------------------------------------------
 * 为什么自己写 PNG 编码器：
 *   项目从第一天起就是「零第三方依赖」，为了几个图标去装 sharp /
 *   canvas 会打破这条原则，而且装依赖在别人的电脑上经常失败。
 *   PNG 的结构其实很简单（签名 + IHDR + IDAT + IEND），
 *   Node 内置 zlib 就能压缩，所以这里手写了一个约 60 行的编码器。
 *
 * 图形设计：
 *   底：蓝 → 绿的对角渐变（蓝＝天空/水，绿＝田野，呼应「知时」与「智农」）
 *   标：白色幼苗（一根茎 + 左右两片叶），与界面左上角的品牌图形完全一致
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
const OUT = path.join(ROOT, 'web', 'icons');

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

const C_TOP = [37, 99, 235];    // #2563eb 品牌蓝
const C_BOT = [22, 163, 74];    // #16a34a 田野绿

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

/** 幼苗图形（单位坐标），scale 用于缩到 maskable 安全区 */
function inGlyph(u, v, scale) {
  // 先把坐标变换到以中心为原点、按 scale 缩放后的坐标系
  const x = (u - 0.5) / scale + 0.5;
  const y = (v - 0.5) / scale + 0.5;

  // 茎：从 y=0.815 到 y=0.335，宽 0.054
  if (inCapsule(x, y, 0.5, 0.815, 0.5, 0.335, 0.027)) return true;
  // 左右两片叶，关于茎对称，叶片上翘 38°
  if (inEllipse(x, y, 0.650, 0.402, 0.156, 0.075, -0.663)) return true;
  if (inEllipse(x, y, 0.350, 0.402, 0.156, 0.075, 0.663)) return true;
  return false;
}

const SS = 4;          // 超采样倍数
const SAMPLES = SS * SS;

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
      <stop offset="0" stop-color="#2563eb"/>
      <stop offset="1" stop-color="#16a34a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="115" ry="115" fill="url(#bg)"/>
  <g fill="#ffffff">
    <rect x="243" y="171" width="26" height="246" rx="13" ry="13"/>
    <ellipse cx="333" cy="206" rx="80" ry="38" transform="rotate(-38 333 206)"/>
    <ellipse cx="179" cy="206" rx="80" ry="38" transform="rotate(38 179 206)"/>
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
