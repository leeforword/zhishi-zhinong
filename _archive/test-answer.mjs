/**
 * test-answer.mjs — 问答逻辑端到端测试
 * 用真实天气数据跑遍所有问答分支
 * 用法：node test-answer.mjs
 */
import { evaluateWeather, bestWindow, RULES } from './rules.mjs';
import { answerQuestion } from './answer.mjs';

const CITIES = {
  '保定':   [38.87, 115.46],
  '石家庄': [38.04, 114.51],
  '邯郸':   [36.61, 114.49],
  '衡水':   [37.74, 115.67]
};

async function fetchWeather(lat, lon) {
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

let pass = 0, fail = 0;
const check = (cond, msg) => { cond ? (pass++, console.log('  ✔ ' + msg)) : (fail++, console.log('  ✘ ' + msg)); };

const QUESTIONS = [
  { q: '下周哪天能打药？',        expect: /打药|窗口/,        forbid: null },
  { q: '什么时候喷药合适',         expect: /打药|窗口/,        forbid: null },
  { q: '这几天要不要浇水？',       expect: /降水|墒|灌溉/,      forbid: null },
  { q: '需要灌溉吗',               expect: /降水|墒|灌溉/,      forbid: null },
  { q: '可以晾晒吗',               expect: /晾晒/,            forbid: null },
  { q: '今天天气怎么样？',         expect: /℃/,               forbid: null },
  { q: '风大不大',                 expect: /风速|℃/,          forbid: null },
  { q: '这地长势如何',             expect: /示意数据|遥感/,     forbid: null },
  { q: '这是什么病？',             expect: /不在我的能力范围|后续版本/, forbid: null },
  { q: '该施什么肥？',             expect: /不在我的能力范围|后续版本/, forbid: null },
  { q: '明天股票涨吗？',           expect: /不在我的处理范围/,   forbid: null }
];

for (const [city, [lat, lon]] of Object.entries(CITIES)) {
  console.log(`\n===== ${city} =====`);
  const w = await fetchWeather(lat, lon);
  const result = evaluateWeather(w.hourly, w.daily);
  const plot = { name: city + '地块', crop: 'wheat', city };

  // 基础数据结构检查
  check(result.days.length === 7, '7 天结果');
  check(typeof result.weekRain === 'number', 'weekRain 为数字');
  check(bestWindow(result) !== undefined, 'bestWindow 可调用');

  for (const { q, expect } of QUESTIONS) {
    let a;
    try { a = answerQuestion(q, result, plot); }
    catch (e) { check(false, `[${q}] 抛异常: ${e.message}`); continue; }
    check(typeof a === 'string' && a.length > 10, `[${q}] 返回有效文本(${a.length}字)`);
    check(expect.test(a), `[${q}] 内容包含预期关键词 ${expect}`);
    // 不允许出现 NaN / undefined
    check(!/NaN|undefined|null/.test(a), `[${q}] 无 NaN/undefined`);
  }

  // 打药回答的日期必须真实存在于结果里
  const sprayAns = answerQuestion('哪天能打药', result, plot);
  const dates = result.days.map(d => {
    const dt = new Date(d.date + 'T00:00:00');
    return `${dt.getMonth()+1}/${dt.getDate()}`;
  });
  const mentioned = dates.filter(x => sprayAns.includes(x));
  check(mentioned.length > 0 || /没有合适/.test(sprayAns), '打药回答中提到的日期来自真实数据');

  // 回答中不得出现未定义的专业术语
  check(!/NDVI|VPD|LAI/.test(sprayAns), '打药回答不含专业术语');
}

// 边界情况
console.log('\n===== 边界测试 =====');
check(/还没加载好/.test(answerQuestion('打药', null, {name:'x'})), 'result 为 null 时给出友好提示');

const w2 = await fetchWeather(38.87, 115.46);
const r2 = evaluateWeather(w2.hourly, w2.daily);
const maizePlot = { name: '玉米地', crop: 'maize', city: '保定' };
const wheatPlot = { name: '麦地', crop: 'wheat', city: '保定' };
const aMaize = answerQuestion('要不要浇水', r2, maizePlot);
const aWheat = answerQuestion('要不要浇水', r2, wheatPlot);
check(typeof aMaize === 'string' && aMaize.length > 0, '玉米地块灌溉回答正常');
check(aMaize !== aWheat, '不同作物的灌溉建议有区分');

console.log(`\n===== 结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
