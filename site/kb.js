/* =============================================================
   知时智农 · 本地知识库（离线索引）
   -------------------------------------------------------------
   说明：这不是"造一个数据库"，而是把项目里已经有的真实数据建成
   可检索的本地索引，离线可用、不联网、不上传：

     · 13 份国家 / 河北省 / 市级农技文件（standards.js，含原文链接）
     · 24 个节气农事提示（content.js）
     · 6 条判定口径（content.js）
     · 167 个河北县级行政区（hebei-geo.js，阿里 DataV GeoAtlas 离线内置）

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
