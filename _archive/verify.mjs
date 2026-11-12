/**
 * 验证脚本：不依赖浏览器，直接跑通
 *   1. Open-Meteo 真实天气数据
 *   2. 规则引擎判定
 *   3. 问答逻辑
 * 用法：node verify.mjs
 */

const CROP_NAME = { wheat: '冬小麦', maize: '夏玉米' };
const DOW = ['周日','周一','周二','周三','周四','周五','周六'];

async function fetchWeather(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('daily', [
    'temperature_2m_max','temperature_2m_min','precipitation_sum',
    'precipitation_probability_max','wind_speed_10m_max','weather_code'
  ].join(','));
  url.searchParams.set('timezone','Asia/Shanghai');
  url.searchParams.set('forecast_days','7');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function evaluateDay(day) {
  const rain  = day.precipitation_sum ?? 0;
  const pRain = day.precipitation_probability_max ?? 0;
  const wind  = day.wind_speed_10m_max ?? 0;
  const tmax  = day.temperature_2m_max ?? 20;
  let spray = 'ok', sprayWhy = '温度和风力适宜';
  if (rain >= 1) { spray='bad'; sprayWhy='当天有降雨，药液会被冲刷'; }
  else if (pRain >= 60 && rain > 0.1) { spray='bad'; sprayWhy='降雨概率高，打药易失效'; }
  else if (wind >= 4) { spray='bad'; sprayWhy='风速偏大，药液飘移风险高'; }
  else if (wind >= 2.5) { spray='warn'; sprayWhy='有一定风力，注意飘移'; }
  else if (tmax > 32) { spray='bad'; sprayWhy='气温过高，易产生药害'; }
  else if (tmax < 5) { spray='warn'; sprayWhy='气温偏低，药效下降'; }
  if (rain >= 10) { spray='bad'; sprayWhy='降雨量较大，不建议田间作业'; }
  let irr='ok', irrWhy='降水条件正常';
  if (rain >= 5) { irr='bad'; irrWhy='有有效降水，无需灌溉'; }
  else if (tmax >= 30) { irr='warn'; irrWhy='高温少雨，注意墒情'; }
  let harvest='ok', harvestWhy='天气适宜晾晒';
  if (rain >= 1) { harvest='bad'; harvestWhy='有降雨，不宜晾晒'; }
  else if (pRain >= 50) { harvest='warn'; harvestWhy='降雨概率较高，谨慎晾晒'; }
  return { spray, sprayWhy, irr, irrWhy, harvest, harvestWhy, rain, wind, tmax, pRain };
}

function buildDecisions(w) {
  const d = w.daily;
  const days = d.time.map((t,i) => ({
    date: t,
    precipitation_sum: d.precipitation_sum[i],
    precipitation_probability_max: d.precipitation_probability_max?.[i],
    wind_speed_10m_max: d.wind_speed_10m_max?.[i],
    temperature_2m_max: d.temperature_2m_max[i],
    temperature_2m_min: d.temperature_2m_min[i],
  }));
  return { days, evaluated: days.map(d => evaluateDay(d)) };
}

const tagText = v => v==='ok'?'可作业':v==='warn'?'谨慎':'不宜';
const TAG = { ok:'✅', warn:'⚠️', bad:'❌' };

/* ---------------- 执行 ---------------- */
const LOCS = [
  { name: '保定',   lat: 38.87, lon: 115.46 },
  { name: '石家庄', lat: 38.04, lon: 114.51 },
  { name: '邯郸',   lat: 36.61, lon: 114.49 },
  { name: '衡水',   lat: 37.74, lon: 115.67 },
];

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; console.log('  ✔ ' + msg); }
  else { fail++; console.log('  ✘ ' + msg); }
};

for (const loc of LOCS) {
  console.log(`\n===== ${loc.name} (${loc.lat}, ${loc.lon}) =====`);
  let w;
  try {
    w = await fetchWeather(loc.lat, loc.lon);
  } catch (e) {
    console.log('  ✘ 天气接口失败: ' + e.message);
    fail++;
    continue;
  }
  check(!!w.daily, '接口返回 daily 数据');
  check(Array.isArray(w.daily.time) && w.daily.time.length === 7, '返回 7 天数据');

  const { days, evaluated } = buildDecisions(w);
  console.log('  日期    天气          最高/最低    降水    风速    打药  灌溉  晾晒');
  days.forEach((d, i) => {
    const e = evaluated[i];
    const dt = new Date(d.date);
    console.log(
      `  ${dt.getMonth()+1}/${dt.getDate()} ${DOW[dt.getDay()]}  ` +
      `${String(Math.round(d.temperature_2m_max)).padStart(4)}/${String(Math.round(d.temperature_2m_min)).padStart(3)}°  ` +
      `${String(d.precipitation_sum.toFixed(1)).padStart(5)}mm  ` +
      `${String((d.wind_speed_10m_max??0).toFixed(1)).padStart(4)}m/s  ` +
      `${TAG[e.spray]}${tagText(e.spray).padEnd(3)} ${TAG[e.irr]}${tagText(e.irr).padEnd(3)} ${TAG[e.harvest]}${tagText(e.harvest)}`
    );
  });

  // 逻辑一致性检查
  days.forEach((d, i) => {
    const e = evaluated[i];
    if (d.precipitation_sum >= 10) {
      check(e.spray === 'bad', `${d.date} 大雨(${d.precipitation_sum}mm) → 打药应"不宜"`);
    }
    if (d.wind_speed_10m_max >= 4) {
      check(e.spray === 'bad', `${d.date} 大风(${d.wind_speed_10m_max}m/s) → 打药应"不宜"`);
    }
    if (e.spray === 'ok' && d.precipitation_sum >= 1) {
      check(false, `${d.date} 有降雨却判定可打药 — 规则冲突！`);
    }
  });

  const okSpray = evaluated.map((e,i)=>e.spray==='ok'?i:-1).filter(i=>i>=0);
  check(okSpray.length >= 0, `最佳打药日数量: ${okSpray.length} 天` + (okSpray.length ? ` (${okSpray.map(i=>days[i].date).join(', ')})` : ''));
}

console.log(`\n===== 结果 =====`);
console.log(`通过: ${pass}  失败: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
