/* =============================================================
   田智 · LLM 增强层
   -------------------------------------------------------------
   设计原则（重要，答辩时要讲）：
     1. 大模型不参与任何数值计算。所有数字来自规则引擎。
     2. 大模型只做三件事：
        a) 意图识别 —— 把用户的自然语言映射到已有的规则分支
        b) 话术改写 —— 把结构化结论说得更像人话
        c) 超范围兜底 —— 不属于能力范围时礼貌拒答
     3. 改写结果必须过"数字一致性校验"：输出里出现的每个数字
        都必须在原始答案中出现过，否则直接丢弃、回退到模板。
        这样即使模型胡编，也不会把错误数字给到用户。
     4. 任何一步失败（无 key / 超时 / 报错）都静默回退到模板回答。
   ============================================================= */
(function (root) {
  'use strict';

  var CFG = root.TIANZHI_CONFIG || {};
  var KEY = CFG.deepseekKey || '';
  var MODEL = CFG.deepseekModel || 'deepseek-chat';
  var ENDPOINT = CFG.deepseekEndpoint || 'https://api.deepseek.com/chat/completions';
  var TIMEOUT = CFG.timeoutMs || 9000;

  var enabled = !!KEY && CFG.enableLLM !== false;
  var stats = { calls: 0, ok: 0, fallback: 0, rejected: 0 };

  function isEnabled() { return enabled; }
  function setEnabled(v) { enabled = !!v && !!KEY; }
  function hasKey() { return !!KEY; }
  function getStats() { return stats; }

  /* ---------------- 底层请求 ---------------- */
  function chat(messages, opts) {
    opts = opts || {};
    if (!enabled) return Promise.reject(new Error('LLM 未启用'));
    if (!navigator.onLine) return Promise.reject(new Error('离线'));

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || TIMEOUT);
    stats.calls++;

    return fetch(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + KEY
      },
      body: JSON.stringify({
        model: MODEL,
        messages: messages,
        temperature: opts.temperature === undefined ? 0.3 : opts.temperature,
        max_tokens: opts.maxTokens || 320,
        stream: false
      })
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j.choices || !j.choices[0]) throw new Error('返回结构异常');
      return j.choices[0].message.content.trim();
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  /* ---------------- 数字一致性校验 ---------------- */
  /** 抽取文本中的数字（含小数） */
  function numbersIn(text) {
    var m = String(text).match(/\d+(?:\.\d+)?/g);
    return m ? m : [];
  }

  /**
   * 校验：改写结果里的数字必须都能在原文中找到。
   *
   * 唯一放行的例外是"时间制式转换"：
   *   原文 14:00 → 改写"下午2点"，17:00 → "下午5点"
   * 这类转换语义完全等价，是自然口语化的一部分。
   * 实现方式：只对原文中出现在"数字 + : 或 时"位置的数字，
   * 额外放行其 12 小时制对应值。其余任何新数字一律拒绝。
   */
  function numbersConsistent(original, rewritten) {
    var allowed = {};
    numbersIn(original).forEach(function (n) { allowed[n] = 1; });

    // 时间制式白名单
    var timeHits = String(original).match(/(\d{1,2})\s*[:：时]/g) || [];
    timeHits.forEach(function (s) {
      var h = parseInt(s, 10);
      if (isNaN(h)) return;
      if (h > 12) allowed[String(h - 12)] = 1;          // 14 → 2
      else if (h === 12) allowed['0'] = 1;              // 12 → 0
      else if (h > 0) allowed[String(h)] = 1;
      if (h > 12) allowed[String(h)] = 1;
    });

    var bad = numbersIn(rewritten).filter(function (n) { return !allowed[n]; });
    return { ok: bad.length === 0, extra: bad };
  }

  /* ---------------- 能力范围 ---------------- */
  var INTENTS = ['spray', 'irrigation', 'harvest', 'weather', 'growth', 'out'];

  var INTENT_LABEL = {
    spray: '打药时机',
    irrigation: '灌溉建议',
    harvest: '晾晒收获',
    weather: '天气查询',
    growth: '长势判读',
    out: '超出能力范围'
  };

  /**
   * 意图识别：把用户的自然语言映射到已有分支。
   * 只返回一个枚举值，不生成任何内容。
   */
  function classify(question) {
    var sys = '你是一个意图分类器。把用户关于农事的问题归到下列类别之一，' +
      '只输出类别英文代码，不要输出任何其他文字、标点或解释。\n' +
      'spray=打药/喷药/施药时机\n' +
      'irrigation=浇水/灌溉/墒情\n' +
      'harvest=晾晒/收获/收割\n' +
      'weather=天气/温度/降雨/风力查询\n' +
      'growth=长势/苗情/长得好不好\n' +
      'out=其他一切（病虫害、施肥、价格、闲聊等）';

    return chat([
      { role: 'system', content: sys },
      { role: 'user', content: question }
    ], { temperature: 0, maxTokens: 8 }).then(function (raw) {
      var t = String(raw).toLowerCase().replace(/[^a-z]/g, '');
      for (var i = 0; i < INTENTS.length; i++) {
        if (t.indexOf(INTENTS[i]) === 0) return INTENTS[i];
      }
      return 'out';
    });
  }

  /**
   * 话术改写：把规则引擎的结构化结论说得更口语化。
   * 强制约束：不得新增/修改任何数字。
   */
  function refine(template, opts) {
    opts = opts || {};
    var sys = '你是农业技术推广员，把下面的"结构化结论"改写成农户听得懂的口语。\n' +
      '硬性要求：\n' +
      '1. 所有数字必须原样保留，一个都不许改、不许新增、不许删。\n' +
      '2. 时间一律保持 24 小时制原样写法（如 10:00–14:00），不要改成"下午两点"。\n' +
      '3. 不要添加任何原文没有的结论或建议。\n' +
      '4. 不超过 120 字，不用 markdown，不用列表符号。\n' +
      '5. 语气朴实，别说"作为AI"之类的话。';

    var user = '地点：' + (opts.place || '本地块') +
      '\n作物：' + (opts.crop || '冬小麦') +
      '\n结构化结论：\n' + template;

    return chat([
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ], { temperature: 0.4, maxTokens: 260 }).then(function (out) {
      var check = numbersConsistent(template, out);
      if (!check.ok) {
        stats.rejected++;
        var err = new Error('数字不一致，已拒绝');
        err.extra = check.extra;
        err.raw = out;
        throw err;
      }
      stats.ok++;
      return out;
    });
  }

  /** 超范围问题的口语化拒答（不含任何数字，天然安全） */
  function refuse(question, capabilities) {
    var sys = '你是"田智"农事决策助手。用户问了一个你能力范围之外的问题，' +
      '请礼貌说明你做不了，并简短提示你能做什么。不超过 60 字，不要编造任何数据。';
    var user = '用户问：' + question + '\n你目前能做：' + capabilities;
    return chat([
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ], { temperature: 0.5, maxTokens: 140 }).then(function (out) {
      stats.ok++;
      return out;
    });
  }

  root.TianZhiLLM = {
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    hasKey: hasKey,
    getStats: getStats,
    classify: classify,
    refine: refine,
    refuse: refuse,
    numbersConsistent: numbersConsistent,
    numbersIn: numbersIn,
    INTENT_LABEL: INTENT_LABEL
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
