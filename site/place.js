/* =============================================================
   知时智农 · 地名解析（市 → 乡镇/街道 → 村）
   -------------------------------------------------------------
   为什么这件事需要单独一个文件：

     需求是"点到哪块地，就告诉我这是哪个村"。听起来简单，
     但实际上没有任何一个免费数据源能稳定给出全国行政村名字：

       · 高德 JS API 逆地理编码  → 权威，能到村，但要有正确的安全密钥
       · BigDataCloud            → 免费无需 key，稳定到"乡镇/街道"
       · 本地县界 GeoJSON        → 离线可用，只到县
       · OSM(Nominatim/Photon)   → 国内村名覆盖零散，还经常限流（实测已放弃）

     所以这里的做法是：**并行问多个源，谁给的更细就用谁的**，
     并且把"精确到哪一级"如实告诉界面——村就是村，只到乡镇就说乡镇，
     不能拿乡镇名字冒充村名。

   坐标约定：
     对外一律 WGS-84；高德服务要 GCJ-02，由调用方传入换算函数。
   ============================================================= */
(function (root) {
  'use strict';

  /* ---------------- 缓存 ---------------- */
  var CACHE = {};
  var CACHE_ORDER = [];
  var CACHE_MAX = 300;

  function cacheKey(lon, lat) {
    // 3 位小数 ≈ 100 米，同一地点反复点选不重复请求
    return Number(lon).toFixed(3) + ',' + Number(lat).toFixed(3);
  }

  function cacheGet(k) { return CACHE[k] || null; }
  function cachePut(k, v) {
    CACHE[k] = v;
    CACHE_ORDER.push(k);
    if (CACHE_ORDER.length > CACHE_MAX) {
      var old = CACHE_ORDER.shift();
      delete CACHE[old];
    }
  }

  /* ---------------- 村名判定 ---------------- */

  /* 只有这些后缀才当"村"。宁可判不出，也不要把"XX小区""XX加油站"当村名。 */
  var VILLAGE_SUFFIX = /(村委会|社区|村|庄|屯|营|寨|沟|铺|集|堡|疃|洼|岭|峪|湾|港|台|坊|店|棚|梢|洼)$/;

  /* 明显是地物/机构而不是聚落的，直接排除 */
  var NOT_VILLAGE = /(公司|集团|工厂|市场|学校|小学|中学|大学|学院|医院|卫生院|银行|信用社|超市|商店|商场|酒店|宾馆|旅馆|餐厅|饭店|食堂|加油站|加气站|充电|停车场|收费站|服务区|管委会|管理处|办公室|委员会|小区|花园|公寓|大厦|广场|公园|游园|水库|大坝|闸|桥|站|机场|火车站|汽车站|景区|文物|遗址|寺|庙|祠|派出所|政府|法院|检察|营业厅|移动|联通|电信|邮政|快递|物流|工业|园区|开发区|养殖场|合作社|农资|种子|化肥)/;

  function cleanName(s) {
    if (!s || typeof s !== 'string') return '';
    var t = s.trim();
    if (!t || t === '[]' || t === 'null') return '';
    return t;
  }

  /** 看起来像不像一个村/聚落名 */
  function looksLikeVillage(name) {
    var n = cleanName(name);
    if (!n || n.length > 12) return false;
    if (NOT_VILLAGE.test(n)) return false;
    return VILLAGE_SUFFIX.test(n);
  }

  /**
   * 从候选里挑村名
   * @param {Array} cands [{name, distance}]  已按距离升序
   * @returns {{name, distance}|null}
   */
  function pickVillage(cands) {
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (looksLikeVillage(c.name)) {
        return { name: cleanName(c.name).replace(/村委会$/, '').replace(/社区$/, ''), distance: c.distance };
      }
    }
    return null;
  }

  /* ---------------- 通用请求 ---------------- */
  function fetchJSON(url, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 8000) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  /* ============================================================
     源一：BigDataCloud（免费、无需 key，稳定到乡镇/街道）
     ============================================================ */
  function fromBigDataCloud(lon, lat) {
    var url = 'https://api.bigdatacloud.net/data/reverse-geocode-client' +
      '?latitude=' + lat + '&longitude=' + lon + '&localityLanguage=zh';

    return fetchJSON(url, 8000).then(function (j) {
      if (!j) return null;

      // administrative 是按 order 从小到大（国 → 省 → 市 → 县 → 乡镇）排列的
      var adm = ((j.localityInfo && j.localityInfo.administrative) || [])
        .filter(function (a) { return a && cleanName(a.name); })
        .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

      var names = adm.map(function (a) { return cleanName(a.name); });
      var deepest = names.length ? names[names.length - 1] : '';
      var city = cleanName(j.city);
      var county = cleanName(j.locality);

      // 最深一级通常就是乡镇/街道；如果它和 city/county 重复，说明只到县
      var township = '';
      if (deepest && deepest !== city && deepest !== county && !/省$/.test(deepest)) {
        township = deepest;
      }

      // city 缺失时从行政区里补（县级市的情况 j.city 会是地级市）
      if (!city) {
        for (var i = names.length - 1; i >= 0; i--) {
          if (/市$/.test(names[i])) { city = names[i]; break; }
        }
      }

      return { city: city, county: county, township: township, village: '', source: 'bigdatacloud' };
    }).catch(function () { return null; });
  }

  /* ============================================================
     源二：高德 JS API 逆地理编码（能到村）
     -------------------------------------------------------------
     ⚠️ 三个坑，都踩过：
       1. 入参必须是 GCJ-02，传 WGS-84 会偏 500 米 → 由调用方换算
       2. 必须先 AMap.plugin('AMap.Geocoder') 才能用
       3. 安全密钥(securityJsCode)配错时返回 INVALID_USER_SCODE，
          这时不能静默失败——要把原因记下来给界面提示
     ============================================================ */
  function fromAMap(AMap, lon, lat, toGcj) {
    return new Promise(function (resolve) {
      if (!AMap || typeof AMap.plugin !== 'function') return resolve(null);

      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      var timer = setTimeout(function () { finish(null); }, 7000);

      var gcj;
      try {
        gcj = (typeof toGcj === 'function') ? toGcj(lon, lat) : [lon, lat];
      } catch (e) { gcj = [lon, lat]; }

      try {
        AMap.plugin('AMap.Geocoder', function () {
          try {
            var geo = new AMap.Geocoder({ radius: 1000, extensions: 'all', city: '全国' });
            geo.getAddress(gcj, function (status, result) {
              clearTimeout(timer);
              if (status !== 'complete' || !result || !result.regeocode) {
                var info = (result && result.info) || '';
                finish(info ? { error: info } : null);
                return;
              }
              var r = result.regeocode;
              var ac = r.addressComponent || {};

              // 高德在直辖市/县级市会把 city 返回成数组，统一成字符串
              var pick = function (v) { return Array.isArray(v) ? (v[0] || '') : cleanName(v); };

              var cands = [];
              (r.aois || []).forEach(function (a) {
                cands.push({ name: a.name, distance: Number(a.distance) || 0 });
              });
              (r.pois || []).forEach(function (a) {
                cands.push({ name: a.name, distance: Number(a.distance) || 0 });
              });
              cands.sort(function (a, b) { return a.distance - b.distance; });

              var v = pickVillage(cands);

              finish({
                city: pick(ac.city),
                county: pick(ac.district),
                township: pick(ac.township),
                village: v ? v.name : '',
                villageDistance: v ? Math.round(v.distance) : null,
                adcode: pick(ac.adcode),
                formatted: r.formattedAddress || '',
                source: 'amap'
              });
            });
          } catch (e) { clearTimeout(timer); finish(null); }
        });
      } catch (e) { clearTimeout(timer); finish(null); }
    });
  }

  /* ============================================================
     合并多源结果：谁更细用谁
     ============================================================ */
  function compose(parts) {
    var city = cleanName(parts.city);
    var county = cleanName(parts.county);
    var township = cleanName(parts.township);
    var village = cleanName(parts.village);

    // 层级从细到粗，取第一个能用的
    var sub = village || township || county || '';

    // 去掉重复：县级市有时 city 和 county 同名
    if (sub && (sub === city)) sub = township && township !== city ? township : '';

    var label;
    if (city && sub) label = city + ' · ' + sub;
    else if (city) label = city;
    else if (sub) label = sub;
    else label = '';

    var precision = village ? 'village' : (township ? 'township' : (county ? 'county' : (city ? 'city' : 'none')));

    return {
      city: city,
      county: county,
      township: township,
      village: village,
      sub: sub,                 // 用于 plot.place 的最细可用名称
      label: label,             // "保定市 · 东洼村"
      precision: precision,
      source: parts.source || '',
      distance: parts.villageDistance || null,
      error: parts.error || ''
    };
  }

  var PRECISION_TEXT = {
    village: '村',
    township: '乡镇/街道',
    county: '县区',
    city: '市',
    none: '未识别'
  };

  /**
   * 解析坐标对应的地名
   * @param {number} lon WGS-84
   * @param {number} lat WGS-84
   * @param {object} opts { AMap, toGcj }
   * @returns {Promise<object>} 恒不 reject，最差也返回 precision='none'
   */
  function resolve(lon, lat, opts) {
    opts = opts || {};
    var k = cacheKey(lon, lat);
    var hit = cacheGet(k);
    if (hit) return Promise.resolve(hit);

    var amapP = opts.AMap
      ? fromAMap(opts.AMap, lon, lat, opts.toGcj)
      : Promise.resolve(null);
    var bdcP = fromBigDataCloud(lon, lat);

    return Promise.all([amapP, bdcP]).then(function (arr) {
      var a = arr[0] || {};
      var b = arr[1] || {};

      var merged = {
        // 市级：高德的更准（它对县级市的处理更细），BigDataCloud 兜底
        city: a.city || b.city || '',
        // 乡镇：两边都给，优先高德
        township: a.township || b.township || '',
        // 县区
        county: a.county || b.county || '',
        // 村：只有高德能给
        village: a.village || '',
        villageDistance: a.villageDistance,
        // 出错原因（例如 INVALID_USER_SCODE），界面上要能说清为什么只到乡镇
        error: a.error || '',
        source: [a.source, b.source].filter(Boolean).join('+')
      };

      var out = compose(merged);
      cachePut(k, out);
      return out;
    }).catch(function () {
      var fallback = compose({});
      return fallback;
    });
  }

  /** 同步取缓存（界面先用它立即渲染，再等异步结果） */
  function cached(lon, lat) { return cacheGet(cacheKey(lon, lat)); }

  root.TianZhiPlace = {
    resolve: resolve,
    cached: cached,
    precisionText: function (p) { return PRECISION_TEXT[p] || PRECISION_TEXT.none; },
    // 便于测试
    _looksLikeVillage: looksLikeVillage,
    _pickVillage: pickVillage,
    _compose: compose,
    _clearCache: function () { CACHE = {}; CACHE_ORDER = []; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
