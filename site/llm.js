/* =============================================================
   农时窗 · LLM 增强层
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
    timeout: CFG.llmTimeoutMs || CFG.timeoutMs || 12000
  };

  var stats = {
    calls: 0, ok: 0, fallback: 0, rejected: 0, lastError: null,
    promptTokens: 0, completionTokens: 0, ms: 0
  };
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
    RT.timeout = CFG.llmTimeoutMs || CFG.timeoutMs || 12000;

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

  /* 同一个问句重问（点两次预设、切回来再问）不该再烧一次 token */
  var CACHE_MAX = 24;
  var cache = new Map();
  function ckey(messages, opts) {
    return (opts.temperature || 0) + '|' + (opts.maxTokens || 0) + '|' +
      messages.map(function (m) { return m.role + ':' + m.content; }).join('\u0001');
  }

  function post(url, headers, body, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) {
        var e = new Error('HTTP ' + r.status);
        e.status = r.status;
        throw e;
      }
      return r.json();
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  /* 限流/超时/网络抖动值得再试一次；401/400 这类重试也没用 */
  function retryable(e) {
    if (!e) return false;
    if (e.status === 429 || e.status >= 500) return true;
    return e.name === 'AbortError' || e.name === 'TypeError';
  }

  function chat(messages, opts) {
    opts = opts || {};
    if (!enabled) return Promise.reject(new Error('LLM 未启用'));
    if (!navigator.onLine) return Promise.reject(new Error('离线'));

    var k = ckey(messages, opts);
    if (cache.has(k)) return Promise.resolve(cache.get(k));

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
      /* 直连：key 在前端（自用/演示），公开部署要么配中转、要么别开 */
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

    var t0 = Date.now();
    stats.calls++;
    stats.lastError = null;

    var run = function () { return post(url, headers, body, opts.timeout || RT.timeout); };

    return run().catch(function (e) {
      if (!retryable(e)) throw e;
      return run();
    }).then(function (j) {
      // 中转回的是 {content}，直连回的是 OpenAI 结构，两种都认
      var out = null;
      if (typeof j.content === 'string') out = j.content.trim();
      else if (j.choices && j.choices[0] && j.choices[0].message) {
        out = String(j.choices[0].message.content || '').trim();
      }
      if (!out) {
        if (j.error && j.error.message) throw new Error(String(j.error.message));
        throw new Error('返回结构异常');
      }
      if (j.usage) {
        stats.promptTokens += j.usage.prompt_tokens || 0;
        stats.completionTokens += j.usage.completion_tokens || 0;
      }
      stats.ms = Date.now() - t0;
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(k, out);
      return out;
    }).catch(function (e) {
      stats.lastError = e && e.name === 'AbortError' ? '超时' : (e && e.message) || '请求失败';
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
  function classify(question, opts) {
    opts = opts || {};
    var sys = '你是一个意图分类器。把用户关于农事的问题归到下列类别之一，' +
      '只输出类别英文代码，不要输出任何其他文字、标点或解释。\n' +
      'spray=打药/喷药/施药时机\n' +
      'irrigation=浇水/灌溉/墒情\n' +
      'harvest=晾晒/收获/收割\n' +
      'weather=天气/温度/降雨/风力查询\n' +
      'growth=长势/苗情/长得好不好\n' +
      'out=其他一切（病虫害、施肥、价格、闲聊等）\n' +
      '用户问题经常省略主语（「那哪天呢」「这药能打吗」），要结合会话上下文判断' +
      '它接着问的是哪种作业、哪个时间范围；拿不准时按上一轮的作业类型归类。\n' +
      '示例：\n' +
      '「那后天呢？」（上轮：除草剂、未来一周）→ spray\n' +
      '「这药怕不怕雨？」（上轮：打完药遇雨）→ spray\n' +
      '「要不要浇一遍」→ irrigation\n' +
      '「能晒粮吗」→ harvest';

    var user = (opts.context ? '【会话上下文】\n' + opts.context + '\n\n' : '') +
      '【用户这一轮的问题】\n' + question;

    return chat([
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ], { temperature: 0, maxTokens: 6 }).then(function (raw) {
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
    var sys = '你是"农时窗"的农事顾问，负责把已经算好的结构化结论，改写成县农技员在电话里会说的话。\n' +
      '你只改表达，不改事实；下面每条都硬性，违反任何一条系统会直接丢弃你的输出。\n' +
      '1. 时间范围与作业/药剂对象必须与原文完全一致：原文是"未来 7 天"就写未来 7 天，是"除草剂"就写除草剂，' +
      '绝不能变成"今天不能打"，也不能补一句用户没问的天气结论。\n' +
      '2. 所有数字、日期、时间点（如 11/22 11:00–15:00）原样保留：不新增、不改写、不省略、不换算成"下午三点"。\n' +
      '3. 第一句给结论（能不能干 / 哪天能干），第二句给关键数字或原因；总长不超过 90 字、最多 2 句。\n' +
      '4. 不用 markdown、不用列表、不用"首先/其次"；不称呼、不感叹、不营销（禁用"乡亲们""注意啦""赶紧""抓紧""！"）。\n' +
      '5. 不添加原文没有的建议（不说"建议加助剂""可以混配""换个药"），不谈药剂品种、剂量与价格。\n' +
      '6. 不复述用户的问题，不说"根据您的问题""作为 AI"。\n' +
      '7. 口语但克制：像农技站的人讲清楚，不像广告，也不像文件。\n' +
      '示例：\n' +
      '原文：除草剂 · 明天不能打。\n低温药害：当日最低温 0℃ ≤ 2℃；下一次窗口 11/23 12:00–15:00。\n' +
      '改写：明天除草剂打不了，最低温 0℃ 已经到药害线；下一个窗口是 11/23 12:00–15:00。\n' +
      '原文：除草剂 · 未来 7 天有 2 天能打：11/22 11:00–15:00（4 小时）、11/23 09:00–15:00（6 小时）。\n' +
      '改写：这周有两天能打：11/22 11:00–15:00 和 11/23 09:00–15:00，11/23 的窗口更长。';

    var user = (opts.context ? '【会话上下文】\n' + opts.context + '\n\n' : '') +
      (opts.question ? '【用户这一轮问】\n' + opts.question + '\n\n' : '') +
      '地点：' + (opts.place || '本地块') +
      '\n作物：' + (opts.crop || '冬小麦') +
      '\n【待改写结论】\n' + template;

    return chat([
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ], { temperature: 0.4, maxTokens: 260 }).then(function (out) {
      var check = numbersConsistent(template, out);
      // 口语化不等于油滑：称呼语、感叹句、营销腔一律拒绝，回退结构化原文
      if (/乡亲|注意啦|朋友们|大家好|赶紧|抓紧|！|!/.test(out)) {
        stats.rejected++;
        var e2 = new Error('语气不合格，已拒绝');
        e2.raw = out;
        throw e2;
      }
      /* 时间范围/药种被换掉，是「答非所问」最常见的形态：
         原文说的是除草剂窗口，改写后只剩「今天不能打药」，
         数字没有新增，但问题对象变了——这种也算不合格。 */
      var keep = (template.match(/除草剂|杀虫剂|杀菌剂|飘移|露水|结露|灌溉|晾晒|浇水/) || [])[0];
      if (keep && out.indexOf(keep) < 0) {
        stats.rejected++;
        var e3 = new Error('问题对象被换掉，已拒绝');
        e3.raw = out;
        throw e3;
      }
      /* 原文只说「未来 7 天」，改写却凭空多出「今天/明天」——同样是换了时间范围 */
      if (/今天|明天|后天/.test(out) && !/今天|明天|后天/.test(template)) {
        stats.rejected++;
        var e5 = new Error('凭空多出日期，已拒绝');
        e5.raw = out;
        throw e5;
      }
      if (!check.ok) {
        stats.rejected++;
        var err = new Error('数字不一致，已拒绝');
        err.extra = check.extra;
        err.raw = out;
        throw err;
      }
      /* 时间点比数字更硬：11/22 11:00–15:00 被改写成「明天下午」，
         数字校验抓不到，但农户照着下地就会扑空。 */
      var times = String(template).match(/\d{1,2}:\d{2}/g) || [];
      var lost = times.filter(function (t) { return out.indexOf(t) < 0; });
      if (lost.length) {
        stats.rejected++;
        var e4 = new Error('时间点被改写丢掉，已拒绝');
        e4.extra = lost;
        e4.raw = out;
        throw e4;
      }
      stats.ok++;
      return shapeLines(out, template);
    });
  }

  /**
   * 首答版式是「结论一行 + 细节一行」，模型常把两句并成一行。
   * 这里按第一个句号补回换行，保证两行结构不被润色破坏；
   * 只在原文本来多行、输出还没换行时动手，不改任何字。
   */
  function shapeLines(out, template) {
    if (!out || out.indexOf('\n') >= 0) return out;
    if ((String(template).match(/\n/g) || []).length < 1) return out;
    var i = out.indexOf('。');
    if (i > 6 && i < out.length - 6) {
      return out.slice(0, i + 1) + '\n' + out.slice(i + 1).replace(/^[，,、\s]+/, '');
    }
    return out;
  }

  /** 超范围问题的口语化拒答（不含任何数字，天然安全） */
  function refuse(question, capabilities, opts) {
    opts = opts || {};
    var sys = '你是"农时窗"农事决策助手。用户问了一个你能力范围之外的问题，' +
      '请礼貌说明你做不了，并简短提示你能做什么。不超过 60 字，不要编造任何数据。' +
      '如果上下文显示用户其实是在追问上一轮的农事时机（时间范围、药种、露水、飘移），' +
      '不要拒答，而是请他把上一轮的问题再说具体一点。';
    var user = (opts.context ? '【会话上下文】\n' + opts.context + '\n\n' : '') +
      '用户问：' + question + '\n你目前能做：' + capabilities;
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
