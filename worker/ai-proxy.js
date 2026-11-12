/**
 * 知时智农 · AI 中转（Cloudflare Worker）
 * -------------------------------------------------------------
 * 为什么需要这个文件：
 *   网站是纯静态的，源码全网可见。如果把 DeepSeek key 写进前端，
 *   任何人右键"查看源代码"就能拿到，拿去刷到欠费。
 *
 *   所以把 key 放在这个 Worker 里（Cloudflare 服务端），前端只知道
 *   Worker 的地址，不知道 key。前端还能用 AI，但偷不到钥匙。
 *
 * 部署方式：见同目录 README.md（有网页版和命令行两种，都是免费的）
 *
 * 需要的环境变量（在 Cloudflare 后台设置，不要写死在代码里）：
 *   DEEPSEEK_KEY      必填。你的模型 key
 *   ALLOWED_ORIGINS   推荐。允许调用本站的域名，逗号分隔，例如：
 *                     https://leeforword.github.io,http://localhost:8931
 *                     留空 = 不限制（不建议，别人可以把你的 Worker 当免费 API 用）
 *   UPSTREAM_URL      选填。默认 https://api.deepseek.com/chat/completions
 *                     换成任何 OpenAI 兼容接口都行
 *   MODEL             选填。默认 deepseek-chat
 *   DAILY_CHAR_BUDGET 选填。单日字符预算，用于粗粒度防刷（默认 300000）
 */

/* 允许透传给上游的字段白名单。
   为什么不直接透传整个 body：防止有人通过中转构造超长请求或多轮刷量。 */
const MAX_MESSAGES = 24;
const MAX_CHARS_PER_MESSAGE = 4000;
const MAX_TOTAL_CHARS = 12000;
const MAX_TOKENS_CAP = 800;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查：部署后浏览器直接打开 Worker 地址就能看到这个
    if (request.method === 'GET') {
      return json({
        ok: true,
        service: '知时智农 · AI 中转',
        note: '这是一个中转服务，只能由网站通过 POST 调用。',
        configured: !!env.DEEPSEEK_KEY
      }, 200, request, env);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(request, env) });
    }

    if (request.method !== 'POST') {
      return json({ error: '只接受 POST' }, 405, request, env);
    }

    // ---- 来源校验：只允许自己的网站调用 ----
    const origin = request.headers.get('Origin') || '';
    if (!originAllowed(origin, env)) {
      return json({ error: '来源不被允许：' + (origin || '(空)') }, 403, request, env);
    }

    if (!env.DEEPSEEK_KEY) {
      return json({ error: '服务端未配置 DEEPSEEK_KEY' }, 500, request, env);
    }

    // ---- 解析并校验请求体 ----
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: '请求体不是合法 JSON' }, 400, request, env);
    }

    const messages = sanitizeMessages(body && body.messages);
    if (!messages) {
      return json({ error: 'messages 字段不合法或过长' }, 400, request, env);
    }

    const temperature = clampNum(body.temperature, 0, 1.2, 0.3);
    const maxTokens = Math.round(clampNum(body.maxTokens, 16, MAX_TOKENS_CAP, 320));
    const model = (env.MODEL || 'deepseek-chat').trim();

    // ---- 转发到上游 ----
    let upstream;
    try {
      upstream = await fetch(env.UPSTREAM_URL || 'https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + env.DEEPSEEK_KEY
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          temperature: temperature,
          max_tokens: maxTokens,
          stream: false
        })
      });
    } catch (e) {
      return json({ error: '上游请求失败：' + e.message }, 502, request, env);
    }

    if (!upstream.ok) {
      // 不把上游的原始报错全文透出去（里面可能带 key 相关线索）
      const status = upstream.status;
      return json({ error: '上游返回 ' + status }, status === 429 ? 429 : 502, request, env);
    }

    let data;
    try {
      data = await upstream.json();
    } catch (e) {
      return json({ error: '上游返回的不是 JSON' }, 502, request, env);
    }

    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;

    if (typeof content !== 'string') {
      return json({ error: '上游返回结构异常' }, 502, request, env);
    }

    // 只回传前端真正要用的部分，不外泄上游的 id / usage / 指纹
    return json({ content: content.trim() }, 200, request, env);
  }
};

/* ---------------- 工具函数 ---------------- */

function sanitizeMessages(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (list.length > MAX_MESSAGES) return null;

  let total = 0;
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') return null;
    const role = m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
    if (typeof m.content !== 'string') return null;
    if (m.content.length > MAX_CHARS_PER_MESSAGE) return null;
    total += m.content.length;
    if (total > MAX_TOTAL_CHARS) return null;
    out.push({ role: role, content: m.content });
  }
  return out;
}

function clampNum(v, min, max, def) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function originAllowed(origin, env) {
  const raw = (env.ALLOWED_ORIGINS || '').trim();
  if (!raw) return true;              // 没配就放行（自己测试方便，正式请配置）
  if (raw === '*') return true;

  return raw.split(',').map((s) => s.trim()).filter(Boolean).some((rule) => {
    if (rule === origin) return true;
    // 支持 *.example.com 这种通配
    if (rule.indexOf('*.') === 0) {
      const suffix = rule.slice(1);            // ".example.com"
      return origin.endsWith(suffix);
    }
    return false;
  });
}

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allow = originAllowed(origin, env) && origin ? origin : (env.ALLOWED_ORIGINS || '*').split(',')[0].trim();
  return {
    'Access-Control-Allow-Origin': allow || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, request, env) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, cors(request, env))
  });
}
