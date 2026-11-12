/**
 * 验证 v2 规则引擎：逐小时分析
 * 用法：node verify2.mjs
 */
import { evaluateWeather, bestWindow, RULES } from './rules.mjs';

const LOCS = [
  { name: '保定',   lat: 38.87, lon: 115.46 },
  { name: '石家庄', lat: 38.04, lon: 114.51 },
  { name: '邯郸',   lat: 36.61, lon: 114.49 },
  { name: '衡水',   lat: 37.74, lon: 115.67 },
];

async function fetchAll(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('hourly', 'temperature_2m,precipitation,wind_speed_10m');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max');
  url.searchParams.set('timezone', 'Asia/Shanghai');
  url.searchParams.set('forecast_days', '7');
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

const TAG = { ok: '✅', warn: '⚠️', bad: '❌' };
const TXT = { ok: '可', warn: '慎', bad: '否' };

let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  ✔ ' + m)) : (fail++, console.log('  ✘ ' + m)); };

console.log('规则版本:', RULES._meta.version);
console.log('依据:', RULES._meta.source);

for (const loc of LOCS) {
  console.log(`\n===== ${loc.name} =====`);
  let w;
  try { w = await fetchAll(loc.lat, loc.lon); }
  catch (e) { console.log('  ✘ 接口失败: ' + e.message); fail++; continue; }

  check(w.hourly?.time?.length === 168, '逐小时数据 168 条（7 天 × 24h）');
  check(w.daily?.time?.length === 7, '逐日数据 7 条');

  const res = evaluateWeather(w.hourly, w.daily);
  check(res.days.length === 7, '规则引擎输出 7 天');

  console.log('  日期    周    温度      降水    打药  灌溉  晾晒   可作业窗口');
  res.days.forEach(d => {
    const win = d.spray.windows.length
      ? d.spray.windows.map(x => `${x.start}:00-${x.end}:00(${x.avgWind}m/s)`).join(' ')
      : '—';
    console.log(
      `  ${d.date.slice(5)}  ${d.dow}  ${String(d.tmax).padStart(3)}/${String(d.tmin).padStart(3)}°  ` +
      `${String(d.dayRain.toFixed(1)).padStart(5)}mm  ` +
      `${TAG[d.spray.status]}${TXT[d.spray.status]}   ${TAG[d.irrigation.status]}${TXT[d.irrigation.status]}   ${TAG[d.harvest.status]}${TXT[d.harvest.status]}   ${win}`
    );
  });

  console.log(`  7 天累计降水: ${res.weekRain}mm`);

  // 一致性检查
  res.days.forEach(d => {
    if (d.spray.windows.length && d.spray.status !== 'ok') check(false, `${d.date} 有窗口但状态非 ok`);
    if (!d.spray.windows.length && d.spray.status === 'ok') check(false, `${d.date} 无窗口却判可作业`);
    d.spray.windows.forEach(wd => {
      check(wd.avgWind <= RULES.spray.wind_max + 0.01, `${d.date} ${wd.start}:00 窗口风速 ${wd.avgWind} ≤ ${RULES.spray.wind_max}`);
      check(wd.hours >= RULES.spray.min_window_hours, `${d.date} 窗口时长 ${wd.hours}h ≥ ${RULES.spray.min_window_hours}h`);
    });
  });

  const best = bestWindow(res);
  if (best) {
    const b = best.spray.windows.sort((a, c) => c.hours - a.hours)[0];
    console.log(`  ★ 最佳作业窗口: ${best.date.slice(5)} ${best.dow} ${b.start}:00–${b.end}:00（${b.hours}h，风 ${b.avgWind}m/s，温 ${b.avgTemp}℃）`);
    check(true, '找到最佳作业窗口');
  } else {
    console.log('  ⚠ 未来 7 天无合适打药窗口');
  }
}

console.log(`\n===== 结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
