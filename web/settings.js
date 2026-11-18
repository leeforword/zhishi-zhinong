/* =============================================================
   农时窗 · 本地设置
   -------------------------------------------------------------
   存两样东西，都只在本机浏览器里，不上传：

     1. AI 配置 —— 中转地址 / 自己的 key / 模型
     2. 农事阈值 —— 风速上限、气温区间、作业时段、降雨拦截

   为什么阈值要做成可改的：
     现行阈值（风速 3.4 m/s、气温 5–32℃）来自公开农技常识，
     没有经过当地农技部门核定。与其藏起来，不如让懂行的人
     按本地标准自己改——这比写死一个数字然后标注"待核实"更负责。

   存储键：zhishi.settings.v1
   读取失败（隐私模式 / 存储被禁）时一律回落到 config.js 的默认值，
   不能因为存不了设置就把页面搞挂。
   ============================================================= */
(function (root) {
  'use strict';

  var KEY = 'zhishi.settings.v1';

  var CFG = root.TIANZHI_CONFIG || {};

  /* ---------------- 默认值 ---------------- */

  function defaultAI() {
    // 配了中转地址就默认走中转；否则看有没有直连 key；都没有就关掉
    var proxyUrl = CFG.llmProxyUrl || '';
    var key = CFG.deepseekKey || '';
    var mode = proxyUrl ? 'proxy' : (key ? 'direct' : 'off');

    return {
      mode: mode,
      proxyUrl: proxyUrl,
      key: key,
      endpoint: CFG.deepseekEndpoint || 'https://api.deepseek.com/chat/completions',
      model: CFG.deepseekModel || 'deepseek-chat'
    };
  }

  function defaultRules() {
    return {
      wind_max: 3.4,        // m/s，逐小时风速上限（<3 级风）
      temp_min: 5,          // ℃，作业气温下限
      temp_max: 30,         // ℃，作业气温上限（NY/T 1276-2025）
      hours_start: 9,       // 省站建议：上午 9 点起
      hours_end: 16,        // 下午 4 点止
      rain_day_max: 0.5,    // mm，当日降水超过即不建议作业
      rain_prev_max: 1.0    // mm，前一日降水超过即拦截
    };
  }

  /* 「按属地标准」是默认，手动滑轴只是后备。
     农户手里没有农技文件，让他自己填风速上限等于把责任推给用户；
     这里改成默认自动套用 standards.js 里的公开文件，用户只在确有必要时覆盖。 */
  function defaultStandard() {
    return {
      mode: 'auto',      // auto = 按地块属地自动取严；manual = 用下面的 rules
      city: ''           // 跟随当前地块的市，由 app.js 写入
    };
  }

  function defaults() {
    return { v: 1, ai: defaultAI(), rules: defaultRules(), standard: defaultStandard() };
  }

  /* ---------------- 读写 ---------------- */

  var cache = null;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function read() {
    if (cache) return cache;
    var d = defaults();
    try {
      var raw = root.localStorage && root.localStorage.getItem(KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o === 'object') {
          // 逐字段合并：以后加了新字段，老用户也不会缺项
          cache = {
            v: 1,
            ai: Object.assign(d.ai, o.ai || {}),
            rules: Object.assign(d.rules, o.rules || {}),
            standard: Object.assign(d.standard, o.standard || {})
          };
          return cache;
        }
      }
    } catch (e) { /* 存储不可用，用默认值 */ }
    cache = d;
    return cache;
  }

  function write(next) {
    cache = next;
    try {
      root.localStorage && root.localStorage.setItem(KEY, JSON.stringify(next));
    } catch (e) { /* 存不了就只在本页生效 */ }
    notify();
  }

  /* ---------------- 订阅 ---------------- */

  var listeners = [];
  function notify() {
    listeners.forEach(function (fn) {
      try { fn(all()); } catch (e) { /* 单个订阅者出错不影响其它 */ }
    });
  }

  /* ---------------- 对外 ---------------- */

  function all() { return clone(read()); }
  function get(section) { return clone(read()[section] || {}); }

  /** 保存某一节（'ai' 或 'rules'），只覆盖传进来的字段 */
  function save(section, patch) {
    var cur = read();
    var next = clone(cur);
    next[section] = Object.assign({}, cur[section] || {}, patch || {});
    write(next);
    return clone(next[section]);
  }

  function reset(section) {
    var d = defaults();
    var next = clone(read());
    if (section) next[section] = d[section];
    else next = d;
    write(next);
  }

  /**
   * 把阈值写进规则引擎（logic.js 里的 RULES）
   *
   * auto 模式：从 standards.js 取属地文件，按「取严」合并后写入，
   *            同时把出处记到 RULES.meta.source，界面上能显示凭什么是这个数。
   * manual 模式：用用户在滑轴里保存的 rules。
   *
   * RULES 是全局共享对象，改了就立刻生效；调用方负责之后重新取一次天气/重算。
   */
  function applyRules(city) {
    var T = root.TianZhi;
    if (!T || !T.applyRuleOverrides) return false;

    var st = read().standard;
    var useCity = city || st.city || '';

    if (st.mode === 'auto') {
      var S = root.TianZhiStandards;
      if (!S) return false;
      var e = S.effective(useCity);
      var ok = T.applyRuleOverrides(e.patch);
      if (T.setRuleSource) T.setRuleSource(e.label + ' · 查证 ' + S.CHECKED);
      return ok;
    }

    var r = read().rules;
    var ok2 = T.applyRuleOverrides(r);
    if (T.setRuleSource) T.setRuleSource('手动校准（自定义阈值）');
    return ok2;
  }

  /** 当前生效的标准摘要，给界面和问答显示 */
  function standardSummary(city) {
    var S = root.TianZhiStandards;
    if (!S) return null;
    var st = read().standard;
    var e = S.effective(city || st.city || '');
    return {
      mode: st.mode,
      city: e.cityName,
      patch: e.patch,
      by: e.by,
      sources: e.sources,
      label: e.label,
      stricter: e.stricter,
      checked: S.CHECKED
    };
  }

  /** 判断 AI 当前是否可用（给「我的」页和问答卡片显示状态用） */
  function aiStatus() {
    var ai = read().ai;
    if (ai.mode === 'off') return { ok: false, mode: 'off', text: '已关闭（纯规则引擎）' };
    if (ai.mode === 'proxy') {
      if (!ai.proxyUrl) return { ok: false, mode: 'proxy', text: '未配置中转地址' };
      return { ok: true, mode: 'proxy', text: '走中转（key 在服务端）' };
    }
    if (ai.mode === 'direct') {
      if (!ai.key) return { ok: false, mode: 'direct', text: '未填写 API Key' };
      return { ok: true, mode: 'direct', text: '直连（key 存在本机）' };
    }
    return { ok: false, mode: 'off', text: '未配置' };
  }

  root.TianZhiSettings = {
    defaults: defaults,
    all: all,
    get: get,
    save: save,
    reset: reset,
    applyRules: applyRules,
    standardSummary: standardSummary,
    aiStatus: aiStatus,
    subscribe: function (fn) { listeners.push(fn); },
    defaultsOf: { ai: defaultAI, rules: defaultRules, standard: defaultStandard }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
