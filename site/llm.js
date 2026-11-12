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

  /* ============================================================
     运行时配置
     -------------------------------------------------------------
     三种模式，优先级由 settings.js（「我的」页可改）决定：

       proxy  → 调自己的 Cloudflare Worker 中转，前端没有 key
       direct → 前端直连，key 存在本机浏览器（仅本地开发用）
       off    → 纯规则引擎，所有 AI 功能静默跳过

     为什么默认是 proxy：仓库是公开的，前端一旦写死 key，
     等于把按量计费的额度送给所有看得见源码的人。
     ============================================================ */
  var RT = {
    mode: 'off',
    endpoint: '',
    proxyUrl: '',
    key: '',
    model: 'deepseek-chat',
    timeout: CFG.timeoutMs || 9000
  };

  var stats = { calls: 0, ok: 0, fallback: 0, rejected: 0, lastError: null };
  var enabled = false;

  function readRuntime() {
    var S = root.TianZhiSettings;
    var ai = S ? S.get('ai') : {
      mode: CFG.llmProxyUrl ? 'proxy' : (CFG.deepseekKey ? 'direct' : 'off'),
      proxyUrl: CFG.llmProxyUrl || '',
      key: CFG.deepseekKey || '',
      endpoint: CFG.deepseekEndpoint || 'https://api.deepseek.com/chat/completions',
      model: CFG.deepseekModel || 'deepseek-chat'
    };

    RT.mode = ai.mode || 'off';
    RT.proxyUrl = ai.proxyUrl || '';
    RT.key = ai.key || '';
    RT.endpoint = ai.endpoint || 'https://api.deepseek.com/chat/completions';
    RT.model = ai.model || 'deepseek-chat';
    RT.timeout = CFG.timeoutMs || 9000;

    enabled = (RT.mode === 'proxy' && !!RT.proxyUrl) || (RT.mode === 'direct' && !!RT.key);
    return RT;
  }

  readRuntime();

  function isEnabled() { return enabled; }

  /** 用户手动关掉 AI（问答卡片右上角的开关）：只关本次，不改设置 */
  function setEnabled(v) {
    enabled = !!v && ((RT.mode === 'proxy' && !!RT.proxyUrl) || (RT.mode === 'direct' && !!RT.key));
  }

  /** 设置改过之后重新读一遍 */
  function reconfigure() { readRuntime(); return enabled; }

  function hasKey() { return RT.mode === 'proxy' ? !!RT.proxyUrl : !!RT.key; }

  function getStats() { return stats; }

  /* ---------------- 底层请求 ---------------- */
  function chat(messages, opts) {
    opts = opts || {};
    if (!enabled) return Promise.reject(new Error('LLM 未启用'));
    if (!navigator.onLine) return Promise.reject(new Error('离线'));

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || RT.timeout);
    stats.calls++;
    stats.lastError = null;

    var url, headers, body;

    if (RT.mode === 'proxy') {
      /* 走中转：不带任何密钥。Worker 那边校验来源域名后自己加 key。
         请求体只发 messages 和两个参数，Worker 会做白名单过滤。 */
      url = RT.proxyUrl;
      headers = { 'Content-Type': 'application/json' };
      body = {
        messages: messages,
        temperature: opts.temperature === undefined ? 0.3 : opts.temperature,
        maxTokens: opts.maxTokens || 320
      };
    } else {
      /* 直连：仅限本地开发。公开部署绝不要用这个模式。 */
      url = RT.endpoint;
      headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + RT.key
      };
      body = {
        model: RT.model,
        messages: messages,
        temperature: opts.temperature === undefined ? 0.3 : opts.temperature,
        max_tokens: opts.maxTokens || 320,
        stream: false
      };
    }

    return fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      // 中转回的是 {content}，直连回的是 OpenAI 结构，两种都认
      if (typeof j.content === 'string') return j.content.trim();
      if (j.choices && j.choices[0] && j.choices[0].message) {
        return String(j.choices[0].message.content || '').trim();
      }
      if (j.error) throw new Error(String(j.error));
      throw new Error('返回结构异常');
    }, function (e) {
      clearTimeout(timer);
      throw e;
    }).catch(function (e) {
      stats.lastError = e.message;
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
    reconfigure: reconfigure,
    hasKey: hasKey,
    getStats: getStats,
    getMode: function () { return RT.mode; },
    classify: classify,
    refine: refine,
    refuse: refuse,
    numbersConsistent: numbersConsistent,
    numbersIn: numbersIn,
    INTENT_LABEL: INTENT_LABEL
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
