/**
 * test-logic.mjs — 逻辑层测试
 * 加载 logic.js（浏览器/Node 双用），用真实天气数据跑遍所有问答分支
 * 用法：node test-logic.mjs [--source=qweather|open-meteo]
 *
 * 为什么默认走和风而不是 Open-Meteo：
 *   和风是主预报源，测试就该测生产实际走的那条路；而且
 *   api.open-meteo.com 在部分网络（含校园网、国内多数出口）不可达，
 *   以前把它写死在测试里，本地跑不通、CI 也可能因第三方故障卡住发布。
 *   现在两个源都试，谁通谁上，两个都不通才报错并说明原因。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// config.js / weather.js 是按浏览器全局写的，先补一个 window 别名
globalThis.window = globalThis;
require('./config.js');
require('./weather.js');

const T = require('./logic.js');
const W = globalThis.TianZhiWeather;

const arg = process.argv.find((a) => a.startsWith('--source='));
const PREFER = arg ? arg.split('=')[1] : 'qweather';

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时 ' + ms + 'ms')), ms))
  ]);
}

let lastSource = '';

async function fetchWeather(lat, lon) {
  const q = () => withTimeout(W._fromQWeather168(lat, lon), 20000, '和风');
  const o = () => withTimeout(W._fromOpenMeteo(lat, lon), 20000, 'Open-Meteo');
  const order = PREFER === 'open-meteo' ? [['open-meteo', o], ['qweather', q]]
                                        : [['qweather', q], ['open-meteo', o]];
  const errors = [];
  for (const [name, fn] of order) {
    try {
      const r = await fn();
      lastSource = name;
      return r;
    } catch (e) {
      errors.push(name + ': ' + e.message);
    }
  }
  throw new Error('两个数据源都取不到 —— ' + errors.join(' / '));
}

const CITIES = {
  '保定':   [38.8729, 115.4625],
  '石家庄': [38.0414, 114.4786],
  '邯郸':   [36.6103, 114.4900],
  '衡水':   [37.7392, 115.6758]
};

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
    // 用引擎自己算出的 blocked，不要在这里重算一遍：
    // 引擎的前一日降水是「逐小时累加」，而 d.dayRain 取的是逐日接口的值，
    // 和风这两个数偶尔对不上（例如逐日 0.0 mm、逐时累加 1.2 mm），
    // 重算就会得出"热力图有窗口、引擎说没有"的假不一致。
    const blocked = d.spray.blocked;
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
