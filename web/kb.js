/* =============================================================
   知时智农 · 本地知识库（离线索引）
   -------------------------------------------------------------
   说明：这不是"造一个数据库"，而是把项目里已经有的真实数据建成
   可检索的本地索引，离线可用、不联网、不上传：

     · 13 份国家 / 河北省 / 市级农技文件（standards.js，含原文链接）
     · 24 个节气农事提示（content.js）
     · 6 条判定口径（content.js）
     · 167 个河北县级行政区（hebei-geo.js，阿里 DataV GeoAtlas 离线内置）
     · 15 份施药气象依据 + 3 类药剂口径 + 6 个专项话题（chem.js，含原文链接）

   用途：
     1. 「依据」弹层里显示"本地知识库 N 条"，并可搜索；
     2. 对话里问到标准 / 节气 / 县名时，直接从本地命中并给出出处，
        不需要联网，也不让大模型自由发挥。

   原则：只索引已有数据，不新增任何未经核实的数字或结论。
   ============================================================= */
(function (root) {
  'use strict';

  var ENTRIES = null;

  function push(list, e) { if (e && e.title) list.push(e); }

  function build() {
    if (ENTRIES) return ENTRIES;
    var list = [];

    /* ---- 1. 标准文件 ---- */
    var STD = root.TianZhiStandards;
    if (STD && STD.LIST) {
      STD.LIST.forEach(function (s) {
        var lim = '';
        if (s.limits) {
          var bits = [];
          if (s.limits.wind_max !== undefined) bits.push('风速 ≤' + s.limits.wind_max + ' m/s');
          if (s.limits.temp_min !== undefined) bits.push('气温 ' + s.limits.temp_min + '–' + s.limits.temp_max + '℃');
          if (s.limits.hours) bits.push('时段 ' + s.limits.hours[0] + ':00–' + s.limits.hours[1] + ':00');
          if (s.limits.rh_min !== undefined) bits.push('湿度 ≥' + s.limits.rh_min + '%');
          lim = bits.join('；');
        }
        push(list, {
          id: 'std:' + s.id,
          type: '标准',
          title: s.code + ' ' + s.title,
          text: s.issuer + '。' + (lim ? lim + '。' : '') + (s.note || ''),
          tags: [s.code, s.title, s.region, s.issuer, s.status === 'repealed' ? '已废止' : ''].join(' '),
          source: s.url,
          sourceLabel: s.urlLabel || '原文'
        });
      });
    }

    /* ---- 2. 节气 ---- */
    var C = root.TianZhiContent;
    if (C && C.terms) {
      Object.keys(C.terms).forEach(function (k) {
        push(list, {
          id: 'term:' + k,
          type: '节气',
          title: k,
          text: C.terms[k],
          tags: '节气 农事 时令 ' + k,
          source: '',
          sourceLabel: '通用农事常识'
        });
      });
    }

    /* ---- 3. 判定口径 ---- */
    if (C && C.rules) {
      C.rules.forEach(function (r, i) {
        push(list, {
          id: 'rule:' + i,
          type: '口径',
          title: r.title,
          text: r.expr + ' 依据：' + r.src,
          tags: '判定 口径 规则 ' + r.title + ' ' + r.expr,
          source: '',
          sourceLabel: '本地规则引擎'
        });
      });
    }

    /* ---- 4. 县级行政区（离线边界数据） ---- */
    var G = root.HEBEI_GEO;
    if (G && G.counties) {
      G.counties.forEach(function (c) {
        push(list, {
          id: 'adm:' + (c.adcode || c.name),
          type: '行政区',
          title: c.name,
          text: '河北省' + (c.city || '') + '，行政区划代码 ' + (c.adcode || '—') + '。本地离线边界数据，可在新增地块时用于县界判读。',
          tags: '行政区 县 地名 ' + c.name + ' ' + (c.city || '') + ' ' + (c.adcode || ''),
          source: '',
          sourceLabel: '阿里 DataV GeoAtlas（离线）'
        });
      });
    }

    /* ---- 5. 施药气象依据（chem.js）：文件原文、药剂口径、专项话题 ----
       这些是「药已定，判此刻能不能施」的可追溯出处，离线可检索。
       只索引 chem.js 里已有的数据，不新增任何结论。 */
    var CH = root.TianZhiChem;
    if (CH && CH.SOURCES) {
      CH.SOURCES.forEach(function (s) {
        push(list, {
          id: 'chem-s:' + s.id,
          type: '施药依据',
          title: s.code,
          text: s.issuer + ' · ' + s.clause + '：' + s.point,
          tags: '施药 打药 农药 天气 风速 温度 露水 结露 逆温 降雨 药效 飘移 ' +
            s.code + ' ' + s.level + ' ' + s.clause,
          source: s.url,
          sourceLabel: s.level + ' · 查证 ' + CH.CHECKED
        });
      });
      Object.keys(CH.TYPES || {}).forEach(function (k) {
        var t = CH.TYPES[k];
        if (k === 'generic') return;
        push(list, {
          id: 'chem-t:' + k,
          type: '药剂口径',
          title: t.label + ' · 施药气象条件',
          text: '风速上限 ' + t.wind_stop + ' m/s；' +
            (t.temp_min_hard !== null && t.temp_min_hard !== undefined ? '硬下限 ' + t.temp_min_hard + '℃；' : '') +
            (t.temp_min_ideal ? '适温下限 ' + t.temp_min_ideal + '℃；' : '') +
            '上限 ' + t.temp_max + '℃；喷后无雨参考 ' + t.rain_free_h + ' h。' +
            t.notes.join(' '),
          tags: '药剂 施药 天气 ' + t.short + ' ' + t.tags,
          source: '',
          sourceLabel: 'chem.js · 施药天气判定（查证 ' + CH.CHECKED + '）'
        });
      });
      Object.keys(CH.TOPICS || {}).forEach(function (k) {
        var t = CH.TOPICS[k];
        var refs = t.ids.map(function (i) {
          return CH.SOURCES.filter(function (s) { return s.id === i; })[0];
        }).filter(Boolean).map(function (s) { return '[' + s.code + '] ' + s.point; }).join('\n');
        push(list, {
          id: 'chem-p:' + k,
          type: '施药话题',
          title: t.name + ' · 判定口径',
          text: refs,
          tags: '施药 天气 判定 ' + t.name + ' ' + k,
          source: '',
          sourceLabel: 'chem.js · 离线依据'
        });
      });
      /* 药剂档案：农户直接说药名（草甘膦、苯磺隆…）时，离线也能命中 */
      (CH.PRODUCTS || []).forEach(function (p) {
        var warn = p.warn ? (p.warn.any || p.warn.wheat || p.warn.maize || '') : '';
        push(list, {
          id: 'chem-d:' + p.key,
          type: '药剂档案',
          title: p.name + ' · ' + p.mode,
          text: p.what + ' ' + p.weather + (warn ? ' ' + warn : ''),
          tags: '药剂 药名 档案 ' + p.name + ' ' + p.mode + ' ' + p.group,
          source: '',
          sourceLabel: 'chem.js · 只判天气条件，不推荐品种'
        });
      });
    }

    ENTRIES = list;
    return list;
  }

  function stats() {
    var list = build();
    var by = {};
    list.forEach(function (e) { by[e.type] = (by[e.type] || 0) + 1; });
    return { total: list.length, by: by };
  }

  /** 关键词检索：标题命中权重最高，其次标签、正文 */
  function search(q, limit) {
    var s = String(q || '').trim();
    if (!s) return [];
    var terms = s.split(/[\s，。、?？!！]+/).filter(function (x) { return x.length >= 1; });
    var out = [];
    build().forEach(function (e) {
      var score = 0;
      terms.forEach(function (t) {
        if (e.title.indexOf(t) >= 0) score += 6;
        if (e.title === t) score += 8;
        if (e.tags.indexOf(t) >= 0) score += 3;
        if (e.text.indexOf(t) >= 0) score += 1;
      });
      if (score > 0) out.push({ e: e, score: score });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, limit || 5).map(function (x) { return x.e; });
  }

  root.TianZhiKB = {
    build: build,
    stats: stats,
    search: search
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
