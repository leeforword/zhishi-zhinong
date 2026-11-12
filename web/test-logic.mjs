/**
 * test-logic.mjs — 逻辑层测试
 * 加载 logic.js（浏览器/Node 双用），用真实天气数据跑遍所有问答分支
 * 用法：node test-logic.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('./logic.js');

const CITIES = {
  '保定':   [38.8729, 115.4625],
  '石家庄': [38.0414, 114.4786],
  '邯郸':   [36.6103, 114.4900],
  '衡水':   [37.7392, 115.6758]
};

async function fetchWeather(lat, lon) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', lat);
  u.searchParams.set('longitude', lon);
  u.searchParams.set('hourly', 'temperature_2m,precipitation,wind_speed_10m,relative_humidity_2m');
  u.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,weather_code');
  u.searchParams.set('timezone', 'Asia/Shanghai');
  u.searchParams.set('forecast_days', '7');
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  ✔ ' + m)) : (fail++, console.log('  ✘ ' + m)); };

console.log('逻辑层版本:', T.RULES.meta.version);
console.log('依据:', T.RULES.meta.source);

const QUESTIONS = [
  { q: '下周哪天能打药？',   expect: /打药|窗口/ },
  { q: '什么时候喷药合适',    expect: /打药|窗口/ },
  { q: '这几天要不要浇水？',  expect: /降水|墒|灌溉/ },
  { q: '需要灌溉吗',          expect: /降水|墒|灌溉/ },
  { q: '可以晾晒吗',          expect: /晾晒/ },
  { q: '今天天气怎么样？',    expect: /℃/ },
  { q: '风大不大',            expect: /风速|℃/ },
  { q: '这地长势如何',        expect: /示意数据|遥感/ },
  { q: '这是什么病？',        expect: /不在我的能力范围|后面版本|后续/ },
  { q: '该施什么肥？',        expect: /不在我的能力范围|后面版本|后续/ },
  { q: '明天股票涨吗？',      expect: /不在我的处理范围/ }
];

for (const [city, [lat, lon]] of Object.entries(CITIES)) {
  console.log(`\n===== ${city} =====`);
  const w = await fetchWeather(lat, lon);
  const result = T.evaluateWeather(w.hourly, w.daily);
  const plot = { name: city + '地块', crop: 'wheat' };

  check(result.days.length === 7, '7 天结果');
  check(typeof result.weekRain === 'number' && !isNaN(result.weekRain), 'weekRain 有效');
  check(result.days.every(d => d.dow && d.tmax !== undefined), '每天字段完整');
  check(result.days.every(d => !/NaN|undefined/.test(d.spray.why)), '打药原因无 NaN');

  const best = T.bestWindow(result);
  if (best) {
    check(/^\d{4}-\d{2}-\d{2}$/.test(best.date), `最佳窗口日期合法: ${best.date}`);
    check(best.spray.windows.length > 0, '最佳窗口含具体时段');
  } else {
    check(true, '本期无窗口（合法结果）');
  }

  // 一致性
  result.days.forEach(d => {
    const has = d.spray.windows.length > 0;
    check(has === (d.spray.status === 'ok'), `${d.date} 窗口与状态一致`);
    d.spray.windows.forEach(wn => {
      check(wn.avgWind <= T.RULES.spray.wind_max + 0.01, `${d.date} 窗口风速合规 ${wn.avgWind}`);
      check(wn.hours >= T.RULES.spray.min_window_hours, `${d.date} 窗口时长合规 ${wn.hours}h`);
    });
  });

  // 图表一致性：热力图逐小时判定 必须与 "该日是否有窗口" 吻合
  const WEEK = result.days;
  WEEK.forEach((d, di) => {
    const hours = T.hoursOf(w.hourly, d.date);
    if (!hours.length) return;
    const prev = di > 0 ? WEEK[di - 1] : null;
    const blocked = d.dayRain > T.RULES.spray.rain_day_max ||
                    (prev && prev.dayRain >= T.RULES.spray.rain_prev_max);
    // 统计作业时段内连续 ok 的最长游程
    let run = 0, bestRun = 0;
    hours
      .filter(h => h.hour >= T.RULES.spray.hours[0] && h.hour < T.RULES.spray.hours[1])
      .sort((a, b) => a.hour - b.hour)
      .forEach(h => {
        if (!blocked && T.hourVerdict(h) === 'ok') { run++; bestRun = Math.max(bestRun, run); }
        else run = 0;
      });
    const heatSaysWindow = bestRun >= T.RULES.spray.min_window_hours;
    const engineSaysWindow = d.spray.status === 'ok';
    check(heatSaysWindow === engineSaysWindow,
      `${d.date} 热力图与引擎一致（热力 ${bestRun}h / 引擎 ${engineSaysWindow ? '有窗口' : '无窗口'}）`);
  });

  for (const { q, expect } of QUESTIONS) {
    let a;
    try { a = T.answerQuestion(q, result, plot); }
    catch (e) { check(false, `[${q}] 抛异常 ${e.message}`); continue; }
    check(typeof a === 'string' && a.length > 8, `[${q}] 有回复`);
    check(expect.test(a), `[${q}] 内容匹配 ${expect}`);
    check(!/NaN|undefined|null/.test(a), `[${q}] 无 NaN`);
  }
}

console.log('\n===== 边界 =====');
check(/还没加载好/.test(T.answerQuestion('打药', null, { name: 'x' })), 'null 结果友好提示');

const w2 = await fetchWeather(38.8729, 115.4625);
const r2 = T.evaluateWeather(w2.hourly, w2.daily);
const wheat = T.answerQuestion('要不要浇水', r2, { name: '麦地', crop: 'wheat' });
const maize = T.answerQuestion('要不要浇水', r2, { name: '玉米地', crop: 'maize' });
check(wheat !== maize, '不同作物灌溉建议有区分');

console.log('\n===== 城市字典 =====');
check(Object.keys(T.CITIES).length >= 20, `城市字典 ${Object.keys(T.CITIES).length} 个`);
check(T.CITIES['衡水'] && T.CITIES['安国'], '含衡水、安国等县级市');

console.log(`\n===== 结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
