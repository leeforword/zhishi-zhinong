/**
 * build-geo.mjs — 生成河北地图数据
 *
 * 数据源：阿里 DataV GeoAtlas 公开行政区划数据
 *   https://geo.datav.aliyun.com/areas_v3/bound/130000.json      河北省轮廓
 *   https://geo.datav.aliyun.com/areas_v3/bound/130000_full.json 河北省+11地级市
 *   https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json  各市+县区
 *
 * 产出：web/hebei-geo.js（普通脚本，file:// 下也能加载）
 *   window.HEBEI_GEO = {
 *     province: [ring...],                 省级轮廓（用于绘制）
 *     cities:   [{name, adcode, rings}],   市界（用于绘制）
 *     counties: [{name, adcode, city, rings}] 县界（用于点选反查）
 *   }
 *
 * 用法：node build-geo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'web', 'hebei-geo.js');

const CITY_CODES = {
  130100: '石家庄市', 130200: '唐山市', 130300: '秦皇岛市', 130400: '邯郸市',
  130500: '邢台市', 130600: '保定市', 130700: '张家口市', 130800: '承德市',
  130900: '沧州市', 131000: '廊坊市', 131100: '衡水市'
};

/* ---------- 几何处理 ---------- */

/** 环面积（用于过滤太小的碎片） */
function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

/** 道格拉斯-普克简化 */
function rdp(points, tol) {
  if (points.length < 3) return points;
  const sqTol = tol * tol;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const [x1, y1] = points[s], [x2, y2] = points[e];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = points[i];
      let d2;
      if (len2 === 0) {
        d2 = (px - x1) ** 2 + (py - y1) ** 2;
      } else {
        let t = ((px - x1) * dx + (py - y1) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d2 = (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
      }
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > sqTol && idx > 0) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** 精度截断 + 简化 + 去小碎片 */
function cleanRings(geom, tol, minArea, precision) {
  const out = [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      if (ringArea(ring) < minArea) continue;
      let r = rdp(ring, tol);
      if (r.length < 4) continue;
      r = r.map(([x, y]) => [
        Math.round(x * precision) / precision,
        Math.round(y * precision) / precision
      ]);
      // 去掉四舍五入后相邻重复点
      const dedup = [];
      for (const p of r) {
        const last = dedup[dedup.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) dedup.push(p);
      }
      if (dedup.length >= 4) out.push(dedup);
    }
  }
  return out;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.json();
}

/* ---------- 主流程 ---------- */
(async () => {
  console.log('拉取河北省轮廓…');
  const prov = await getJSON('https://geo.datav.aliyun.com/areas_v3/bound/130000.json');
  const provinceRings = [];
  for (const f of prov.features) {
    cleanRings(f.geometry, 0.01, 0.002, 10000).forEach(r => provinceRings.push(r));
  }
  console.log('  轮廓环数:', provinceRings.length, '点数:', provinceRings.reduce((a, r) => a + r.length, 0));

  console.log('拉取地级市边界…');
  const cityFC = await getJSON('https://geo.datav.aliyun.com/areas_v3/bound/130000_full.json');
  const cities = cityFC.features.map(f => ({
    name: f.properties.name,
    adcode: String(f.properties.adcode),
    rings: cleanRings(f.geometry, 0.01, 0.002, 10000)
  }));
  console.log('  市数:', cities.length, '点数:', cities.reduce((a, c) => a + c.rings.reduce((b, r) => b + r.length, 0), 0));

  console.log('拉取县级边界…');
  const counties = [];
  for (const [code, cname] of Object.entries(CITY_CODES)) {
    const fc = await getJSON(`https://geo.datav.aliyun.com/areas_v3/bound/${code}_full.json`);
    for (const f of fc.features) {
      const rings = cleanRings(f.geometry, 0.012, 0.001, 10000);
      if (!rings.length) continue;
      counties.push({
        name: f.properties.name,
        adcode: String(f.properties.adcode),
        city: cname,
        rings
      });
    }
    process.stdout.write(`  ${cname} ${fc.features.length} 个单元\n`);
  }
  const cPoints = counties.reduce((a, c) => a + c.rings.reduce((b, r) => b + r.length, 0), 0);
  console.log('  县区数:', counties.length, '点数:', cPoints);

  /* ---------- 输出为 JS（避免 file:// 下 fetch 限制） ---------- */
  const payload = { source: '阿里 DataV GeoAtlas', generated: new Date().toISOString().slice(0, 10), province: provinceRings, cities, counties };
  const js = '/* 河北行政区划数据 — 由 build-geo.mjs 生成，来源：阿里 DataV GeoAtlas */\n' +
             'window.HEBEI_GEO = ' + JSON.stringify(payload) + ';\n';
  fs.writeFileSync(OUT, js, 'utf8');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`\n已写入 ${path.relative(process.cwd(), OUT)}  ${kb} KB`);

  // 顺带输出几个县的中心，便于核对
  function centroid(rings) {
    let sx = 0, sy = 0, n = 0;
    for (const r of rings) for (const [x, y] of r) { sx += x; sy += y; n++; }
    return [sx / n, sy / n];
  }
  const probe = ['河间市', '安国市', '定州市', '宁晋县', '涿州市'];
  for (const name of probe) {
    const c = counties.find(x => x.name === name);
    if (c) {
      const [lon, lat] = centroid(c.rings);
      console.log(`  ${name}: ${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E  (${c.city})`);
    } else {
      console.log(`  ${name}: 未找到`);
    }
  }
})();
