/**
 * answer.mjs — 问答逻辑（规则引擎驱动）
 *
 * 设计原则：
 *   1. 所有数字都来自 evaluateWeather() 的真实计算结果，不做任何编造
 *   2. 超出作用域的问题明确拒答，不硬答
 *   3. 输出面向种植户，用"哪天几点干什么"，不出现专业术语
 */

import { RULES, bestWindow } from './rules.mjs';

const CROP_NAME = { wheat: '冬小麦', maize: '夏玉米' };

function fmtDate(date, result) {
  const dt = new Date(date + 'T00:00:00');
  const dow = result.days.find(x => x.date === date)?.dow || '';
  return `${dt.getMonth() + 1}/${dt.getDate()}（${dow}）`;
}

function hh(h) {
  return String(h).padStart(2, '0');
}

/**
 * @param {string} q      用户问题
 * @param {object} result evaluateWeather() 的返回值
 * @param {object} plot   当前地块 { name, crop, city }
 * @returns {string}      答案（纯文本，\n 为换行）
 */
export function answerQuestion(q, result, plot) {
  if (!result) return '天气数据还没加载好，请稍候再问。';

  const tag = `【${plot.name}】`;

  /* ---------- 打药 ---------- */
  if (/打药|喷药|施药|农药|喷雾|喷洒/.test(q)) {
    const ok = result.days.filter(d => d.spray.status === 'ok' && d.spray.windows.length);

    if (!ok.length) {
      const reasons = [...new Set(result.days.map(d => d.spray.why))].slice(0, 2);
      return `${tag}未来 7 天没有合适的打药窗口。\n\n主要原因：\n${reasons.map(r => '· ' + r).join('\n')}\n\n建议继续观察天气，或咨询当地农技部门。`;
    }

    const lines = ok.map(d => {
      const w = [...d.spray.windows].sort((a, b) => b.hours - a.hours)[0];
      return `· ${fmtDate(d.date, result)} ${hh(w.start)}:00–${hh(w.end)}:00（可作业 ${w.hours} 小时，风速 ${w.avgWind} m/s，气温 ${w.avgTemp}℃）`;
    }).join('\n');

    const best = bestWindow(result);
    const bw = [...best.spray.windows].sort((a, b) => b.hours - a.hours)[0];

    return `${tag}未来 7 天有 ${ok.length} 天可以打药：\n\n${lines}\n\n★ 推荐 ${fmtDate(best.date, result)} ${hh(bw.start)}:00–${hh(bw.end)}:00，这段时间连续可作业 ${bw.hours} 小时，平均风速只有 ${bw.avgWind} m/s，是最从容的窗口。\n\n判断依据：在 6:00–17:00 作业时段内，逐小时风速不超过 ${RULES.spray.wind_max} m/s、气温在 ${RULES.spray.temp_min}–${RULES.spray.temp_max}℃ 之间，且前后无降雨。`;
  }

  /* ---------- 灌溉 ---------- */
  if (/浇|灌水|灌溉|墒|水肥|补水|旱|缺水/.test(q)) {
    const today = result.days[0];
    const rainDays = result.days.filter(d => d.dayRain >= 1).length;
    const head = rainDays
      ? `未来 7 天累计降水 ${result.weekRain} mm，有 ${rainDays} 天可能出现降水。`
      : `未来 7 天累计降水只有 ${result.weekRain} mm，基本没有有效降水。`;

    let advice;
    if (result.weekRain < RULES.irrigation.rain_7d_threshold) {
      advice = plot.crop === 'wheat'
        ? '当前冬小麦处于越冬前，如果墒情不足，建议抓住晴好天气安排冬灌，灌后注意划锄保墒。'
        : '未来一周降水偏少，注意关注土壤墒情，必要时安排灌溉。';
    } else {
      advice = '降水条件基本正常，按常规管理即可。';
    }

    return `${tag}${head}\n\n今日建议：${today.irrigation.why}。\n\n${advice}\n\n判断依据：7 天累计降水阈值 ${RULES.irrigation.rain_7d_threshold} mm。`;
  }

  /* ---------- 晾晒 / 收获 ---------- */
  if (/晾晒|收获|收粮|晒|收割/.test(q)) {
    const good = result.days.filter(d => d.harvest.status === 'ok');
    if (!good.length) {
      return `${tag}未来 7 天暂无明显适宜的晾晒窗口，降雨或湿度条件不理想。`;
    }
    return `${tag}未来 7 天有 ${good.length} 天适宜晾晒：${good.map(d => fmtDate(d.date, result)).join('、')}。\n\n判断依据：当日降水小于 ${RULES.harvest.rain_max} mm 且降雨概率低于 ${RULES.harvest.prob_max}%。`;
  }

  /* ---------- 天气 ---------- */
  if (/天气|下雨|降水|温度|气温|风|冷不冷|热不热/.test(q)) {
    const t = result.days[0];
    const rainTxt = t.dayRain > 0 ? `预计降水 ${t.dayRain.toFixed(1)} mm` : '预计无降水';
    return `${tag}今日（${fmtDate(t.date, result)}）最高 ${t.tmax}℃、最低 ${t.tmin}℃，${rainTxt}，日最大风速 ${t.windMax} m/s。\n\n未来 7 天累计降水 ${result.weekRain} mm。`;
  }

  /* ---------- 长势 ---------- */
  if (/长势|苗情|长得|NDVI|遥感/.test(q)) {
    return `${tag}长势判读目前使用示意数据，真实遥感接入是后续版本的工作。\n\n目前我已经能基于实时天气给出农事窗口判断。如果你关心"这块地是否需要加强管理"，可以先看我给出的灌溉和打药建议。`;
  }

  /* ---------- 超出作用域，明确拒答 ---------- */
  if (/病|虫|草|杂草|肥|土|种|品种|药名|用什么药|打什么药/.test(q)) {
    return `病虫害识别和测土配方施肥目前还不在我的能力范围内——这两个方向需要图像识别和土壤检测数据，是后续版本要做的。\n\n我现在能回答的是：\n· 哪天、几点适合打药\n· 要不要浇水\n· 今天和未来 7 天的天气`;
  }

  /* ---------- 兜底 ---------- */
  return '这个问题还不在我的处理范围内。你可以这样问我：\n· 哪天能打药？\n· 这几天要不要浇水？\n· 今天天气怎么样？';
}

export { CROP_NAME };
