/* =============================================================
   知时智农 · 集合预报 → 农事窗口置信度
   -------------------------------------------------------------
   这一层是对现有规则引擎的增强，不改动原有确定性判断。

   要解决的问题
   ------------
   现有输出是「11/12 10:00–17:00 可作业」。看起来确定，但其实是
   拿单一确定性预报算的。预报本身有不确定性，农户并不知道
   这个窗口有多稳、什么情况下会收窄、错过会怎样。

   这一层把「集合预报的离散度」翻译成「决策的时间容错区间」：
     · 50 个集合成员各自算一遍窗口
     · 统计每个小时有多少成员认为可作业 → 逐小时可作业概率
     · 由概率推出：窗口区间、置信等级、窗口关闭条件

   关键设计原则
   ------------
   1. 纯函数、确定性。同样的输入必然同样的输出，可复现、可审计。
   2. 只做"翻译"，不做"决策"。规则仍是原来的规则，
      这里只是把同一套规则跑 50 遍，看结论有多稳。
   3. 没有集合数据时优雅退回：给出 null，界面显示原来的确定性窗口，
      不假装有置信度。
   ============================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TianZhiEnsemble = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* -----------------------------------------------------------
     一、集合数据的解析
     -------------------------------------------------------------
     Open-Meteo ensemble API 返回形如：
       hourly: {
         time: [...],
         precipitation: [...],            // 控制成员（可无）
         precipitation_member01: [...],
         precipitation_member02: [...],
         ...                              // 最多 50 个
       }
     ----------------------------------------------------------- */

  /** 从 Open-Meteo 返回里抽出各成员的逐时序列 */
  function parseMembers(json, variable) {
    if (!json || !json.hourly || !json.hourly.time) return null;

    var h = json.hourly;
    var time = h.time;

    // 找出所有 member 列
    var re = new RegExp('^' + variable + '_member(\\d+)$');
    var keys = Object.keys(h).filter(function (k) { return re.test(k); });
    keys.sort();

    // 没有 member 列时，退回控制成员（单值），视作 1 个成员
    if (!keys.length) {
      if (h[variable]) {
        return { time: time, members: [h[variable]], count: 1, control: true };
      }
      return null;
    }

    var members = keys.map(function (k) { return h[k]; });
    return { time: time, members: members, count: members.length, control: false };
  }

  /** 把 {time, members} 按日期分组，便于逐日处理 */
  function groupByDate(parsed) {
    if (!parsed) return {};
    var out = {};
    for (var i = 0; i < parsed.time.length; i++) {
      var d = parsed.time[i].slice(0, 10);
      var hr = parseInt(parsed.time[i].slice(11, 13), 10);
      if (!out[d]) out[d] = [];
      out[d].push({ idx: i, hour: hr });
    }
    return out;
  }

  /* -----------------------------------------------------------
     二、单个成员的可作业判定
     -------------------------------------------------------------
     必须与主规则引擎（logic.js 的 RULES.spray / findSprayWindows）
     保持完全一致，否则置信度就是在为另一套规则背书。
     这里不 import logic.js，是为了让本模块可以独立测试；
     参数通过 rule 传入，默认值与 logic.js 对齐。

     ⚠️ 改 logic.js 的 spray 阈值时，这里必须同步改，否则
        确定性结论和集合置信度会互相矛盾。
     ----------------------------------------------------------- */

  var DEFAULT_RULE = {
    hours: [6, 17],
    wind_max: 3.4,          // ≈3 级风，与 logic.js RULES.spray.wind_max 对齐
    temp_min: 5,
    temp_max: 32,
    rain_hour_max: 0.1,     // 逐小时降水超过此值视为不能打药
    min_window_hours: 2
  };

  /**
   * 计算某天逐小时的可作业概率
   *
   * 返回：{ date, hours: [{hour, prob, memberOk}], memberCount, agreement }
   *   prob      该小时有多少比例成员认为可作业（0–1）
   *   memberOk  可作业的成员数
   */
  function hourlyProbability(data, date, rule, rawDaily) {
    var r = rule || DEFAULT_RULE;
    if (!data || !data.precip) return null;

    var groups = groupByDate(data.precip);
    var list = groups[date];
    if (!list) return null;

    var n = data.precip.count;
    if (!n) return null;

    var out = [];
    for (var i = 0; i < list.length; i++) {
      var hour = list[i].hour;
      if (hour < r.hours[0] || hour > r.hours[1]) continue;
      var idx = list[i].idx;

      var okCount = 0;
      for (var m = 0; m < n; m++) {
        var wind = data.wind ? data.wind.members[m][idx] : 0;
        var temp = data.temp ? data.temp.members[m][idx] : 20;
        var rain = data.precip.members[m][idx] || 0;

        if (wind === null || wind === undefined) continue;
        if (rain > r.rain_hour_max) continue;
        if (temp < r.temp_min) continue;
        if (temp > r.temp_max) continue;
        if (wind > r.wind_max) continue;
        okCount++;
      }
      out.push({ hour: hour, prob: okCount / n, memberOk: okCount });
    }

    if (!out.length) return null;

    // 全体一致性：所有小时的平均可作业概率
    var sum = out.reduce(function (a, h) { return a + h.prob; }, 0);
    return {
      date: date,
      hours: out,
      memberCount: n,
      agreement: sum / out.length
    };
  }

  /* -----------------------------------------------------------
     三、窗口置信度
     -------------------------------------------------------------
     把逐小时概率拼成"连续满足阈值的小时序列"，得到：
       · 窗口区间（起止小时）
       · 置信等级（高 / 中 / 低）
       · 窗口内最脆弱的小时（最可能先崩的那一环）

     置信等级怎么定（这是本模块的核心判断）
     --------------------------------------
     用「窗口内最低的可作业概率」而不是平均值。
     理由：一个窗口能不能用，取决于它最薄弱的那一环。
     平均 80% 但中间有一小时只有 40% 的窗口，不能算高置信。

       高：最弱小时 ≥ 70% 成员支持，且窗口宽度 ≥ 2 小时
       中：最弱小时 ≥ 50%
       低：最弱小时 < 50%
     ----------------------------------------------------------- */

  var CONF = {
    high: { key: 'high', label: '高', min: 0.70, color: '#16a34a' },
    mid: { key: 'mid', label: '中', min: 0.50, color: '#d97706' },
    low: { key: 'low', label: '低', min: 0, color: '#dc2626' }
  };

  function levelOf(weakest) {
    if (weakest >= CONF.high.min) return CONF.high;
    if (weakest >= CONF.mid.min) return CONF.mid;
    return CONF.low;
  }

  /**
   * 从逐小时概率里提取窗口
   *
   * @param {Object} hourly  hourlyProbability() 的返回
   * @param {Number} minProb 认为"该小时可作业"的概率阈值
   * @param {Number} minLen  最小连续长度（小时）
   */
  function extractWindows(hourly, minProb, minLen) {
    if (!hourly) return [];
    var thr = minProb === undefined ? 0.5 : minProb;
    var need = minLen === undefined ? 2 : minLen;

    var wins = [];
    var cur = null;

    hourly.hours.forEach(function (h) {
      if (h.prob >= thr) {
        if (!cur) cur = [];
        cur.push(h);
      } else {
        if (cur && cur.length >= need) wins.push(cur);
        cur = null;
      }
    });
    if (cur && cur.length >= need) wins.push(cur);

    return wins.map(function (list) {
      var weakest = list.reduce(function (a, h) {
        return h.prob < a.prob ? h : a;
      }, list[0]);
      var avg = list.reduce(function (a, h) { return a + h.prob; }, 0) / list.length;
      return {
        start: list[0].hour,
        end: list[list.length - 1].hour + 1,
        hours: list.length,
        avgProb: avg,
        weakest: weakest,
        hoursList: list
      };
    });
  }

  /**
   * 完整评估：某一天的窗口 + 置信度
   *
   * @returns null 或 {
   *   date, windows: [{start,end,hours,avgProb,level,weakest}],
   *   best, closeCondition, memberCount
   * }
   */
  function evaluateDay(data, date, rule, minProb, minLen) {
    var hp = hourlyProbability(data, date, rule);
    if (!hp) return null;

    var raw = extractWindows(hp, minProb, minLen);
    var windows = raw.map(function (w) {
      var lv = levelOf(w.weakest.prob);
      return {
        start: w.start,
        end: w.end,
        hours: w.hours,
        avgProb: w.avgProb,
        weakest: w.weakest,
        level: lv,
        // 窗口内每个小时的成员支持率，用于画置信条
        strip: w.hoursList.map(function (h) {
          return { hour: h.hour, prob: h.prob };
        })
      };
    });

    if (!windows.length) {
      return {
        date: date,
        windows: [],
        best: null,
        hourly: hp,
        memberCount: hp.memberCount
      };
    }

    // 最佳窗口：先看等级，再看长度
    var order = { high: 3, mid: 2, low: 1 };
    var best = windows.slice().sort(function (a, b) {
      if (order[b.level.key] !== order[a.level.key]) return order[b.level.key] - order[a.level.key];
      return b.hours - a.hours;
    })[0];

    return {
      date: date,
      windows: windows,
      best: best,
      hourly: hp,
      memberCount: hp.memberCount,
      closeCondition: closeConditionOf(best, hp)
    };
  }

  /* -----------------------------------------------------------
     四、窗口关闭条件
     -------------------------------------------------------------
     告诉农户「什么情况下这个窗口会没了」。这是本功能的关键：
     不只是给结论，而是给结论失效的条件。
     ----------------------------------------------------------- */

  function closeConditionOf(best, hourly) {
    if (!best) return null;
    var r = DEFAULT_RULE;

    var weak = best.weakest;
    var parts = [];

    // 找窗口内最脆弱的约束类型：从成员数据里看不出来，
    // 这里用"最弱小时的失败方向"推断——用概率反推原因
    var failRate = 1 - weak.prob;

    if (failRate > 0) {
      parts.push('若 ' + pad2(weak.hour) + ':00 前后风速超过 ' + r.wind_max + ' m/s 或气温低于 ' +
                 r.temp_min + '℃ 的成员比例上升，窗口会先从这一小时断开');
    }

    // 用最小二乘意义下的"再掉多少会降级"
    var toMid = weak.prob - CONF.mid.min;
    var toLow = weak.prob - 0.0;
    if (weak.prob >= CONF.high.min) {
      parts.push('置信度从「高」降到「中」的临界点：' + pad2(weak.hour) + ':00 的支持率跌到 ' +
                 Math.round(CONF.high.min * 100) + '% 以下（现为 ' + Math.round(weak.prob * 100) + '%）');
    } else if (weak.prob >= CONF.mid.min) {
      parts.push('置信度从「中」降到「低」的临界点：' + pad2(weak.hour) + ':00 的支持率跌到 ' +
                 Math.round(CONF.mid.min * 100) + '% 以下（现为 ' + Math.round(weak.prob * 100) + '%）');
    }

    return parts.join('；');
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* -----------------------------------------------------------
     五、推迟代价：窗口挪一天，风险怎么变
     -------------------------------------------------------------
     这是"若推迟到第 7 天，干热风风险从 22% 升到 47%"的实现。
     用集合成员算：有多少比例成员在目标那天不满足作业条件。
     ----------------------------------------------------------- */

  function riskOnDay(data, date, rule) {
    var hp = hourlyProbability(data, date, rule);
    if (!hp || !hp.hours.length) return null;
    // 风险 = 1 - 平均可作业概率
    return {
      date: date,
      risk: 1 - hp.agreement,
      agreement: hp.agreement,
      memberCount: hp.memberCount
    };
  }

  /**
   * 目标日风险 vs 最佳日风险，给出推迟的代价
   */
  function delayCost(data, bestDate, otherDate, rule) {
    var a = riskOnDay(data, bestDate, rule);
    var b = riskOnDay(data, otherDate, rule);
    if (!a || !b) return null;
    return {
      from: a,
      to: b,
      deltaRisk: b.risk - a.risk,
      // 只报有意义的变化
      meaningful: Math.abs(b.risk - a.risk) >= 0.05
    };
  }

  /* -----------------------------------------------------------
     七、降级方案：多模型分歧
     -------------------------------------------------------------
     集合预报域名（ensemble-api.open-meteo.com）不稳定，实测
     5 次里 3 次连接超时。取不到时退回这一条路：
     用主接口一次取 4 个模型的确定性预报，当作"4 个成员"。

     诚实的局限性：
       这不是真正的集合预报。真集合是同一模型跑很多次初始场，
       反映的是初值不确定性；多模型分歧反映的是模型结构差异。
       但"4 个模型都认为能干活"仍然是有意义的信号，
       而且和主预报同域名，几乎不会失败。

     界面必须标明是哪一种，不能让用户以为是 50 成员集合。
     ----------------------------------------------------------- */

  /**
   * 把 Open-Meteo multi-model 返回转成 members 结构
   * 返回 { time, members: [[...]], count, names: [...] }
   */
  function parseMultiModel(json, variable) {
    if (!json || !json.hourly || !json.hourly.time) return null;
    var h = json.hourly;
    var names = json.model_names || [];

    // 多模型返回的列名形如 temperature_2m_ecmwf_ifs025
    var keys = Object.keys(h).filter(function (k) {
      return k.indexOf(variable + '_') === 0 && k !== variable;
    });
    if (!keys.length) {
      // 只有一列（单模型返回）
      if (h[variable]) {
        return { time: h.time, members: [h[variable]], count: 1, names: ['default'] };
      }
      return null;
    }

    keys.sort();
    return {
      time: h.time,
      members: keys.map(function (k) { return h[k]; }),
      count: keys.length,
      names: keys.map(function (k) { return k.slice(variable.length + 1); })
    };
  }

  function assembleMultiModel(json) {
    if (!json || !json.hourly) return null;
    var precip = parseMultiModel(json, 'precipitation');
    var wind = parseMultiModel(json, 'wind_speed_10m');
    var temp = parseMultiModel(json, 'temperature_2m');
    if (!precip) return null;
    // 统一成员数：取最小值，避免某些模型缺变量导致越界
    var n = Math.min(
      precip.count,
      wind ? wind.count : precip.count,
      temp ? temp.count : precip.count
    );
    if (n < precip.count) {
      precip = { time: precip.time, members: precip.members.slice(0, n), count: n, names: precip.names.slice(0, n) };
    }
    if (wind && wind.count > n) {
      wind = { time: wind.time, members: wind.members.slice(0, n), count: n, names: wind.names.slice(0, n) };
    }
    if (temp && temp.count > n) {
      temp = { time: temp.time, members: temp.members.slice(0, n), count: n, names: temp.names.slice(0, n) };
    }
    return { precip: precip, wind: wind, temp: temp, isMultiModel: true };
  }

  /* -----------------------------------------------------------
     八、对外接口
     ----------------------------------------------------------- */

  /**
   * assemble — 从 Open-Meteo ensemble 返回组装出可用的数据结构
   */
  function assemble(json) {
    if (!json || !json.hourly) return null;
    var precip = parseMembers(json, 'precipitation');
    var wind = parseMembers(json, 'wind_speed_10m');
    var temp = parseMembers(json, 'temperature_2m');
    if (!precip) return null;
    return { precip: precip, wind: wind, temp: temp, isMultiModel: false };
  }

  /**
   * assembleBest — 优先用真集合，取不到再用多模型分歧
   * @returns { data, kind: 'ensemble'|'multi-model'|null, label }
   */
  function assembleBest(ensembleJson, multiModelJson) {
    var a = assemble(ensembleJson);
    if (a) {
      return {
        data: a,
        kind: 'ensemble',
        label: '集合预报 · ' + a.precip.count + ' 个成员',
        caveat: ''
      };
    }
    var b = assembleMultiModel(multiModelJson);
    if (b) {
      return {
        data: b,
        kind: 'multi-model',
        label: '多模型对比 · ' + b.precip.count + ' 个模型',
        caveat: '集合预报服务暂不可用，改用多模型分歧评估，仅供参考'
      };
    }
    return null;
  }

  return {
    CONF: CONF,
    DEFAULT_RULE: DEFAULT_RULE,
    parseMembers: parseMembers,
    parseMultiModel: parseMultiModel,
    groupByDate: groupByDate,
    hourlyProbability: hourlyProbability,
    extractWindows: extractWindows,
    evaluateDay: evaluateDay,
    levelOf: levelOf,
    riskOnDay: riskOnDay,
    delayCost: delayCost,
    closeConditionOf: closeConditionOf,
    assemble: assemble,
    assembleMultiModel: assembleMultiModel,
    assembleBest: assembleBest,
    pad2: pad2
  };
});
