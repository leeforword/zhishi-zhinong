/* =============================================================
   知时智农 · 安装与离线（PWA）
   -------------------------------------------------------------
   这个文件只负责一件事：让「装到手机桌面」这件事变得可发现。

   为什么需要它——三种人打开同一个网址，情况完全不同：

     安卓 Chrome / Edge
       支持安装，但浏览器自己那个安装入口藏得很深，多数人找不到。
       这里监听 beforeinstallprompt，把安装按钮直接放到顶栏。

     iPhone Safari
       根本不存在安装 API，只能手动「分享 → 添加到主屏幕」。
       所以这里给的是图文步骤，不是按钮。

     微信内置浏览器（最常见的情况）
       微信里既不能安装，也不能调用分享菜单里的「添加到主屏幕」。
       唯一的出路是「在浏览器中打开」，这一句必须明确告诉用户，
       否则他会一直点，然后以为这个网站坏了。

   除了安装，还顺带处理两件事：新版本提示、断网提示。
   ============================================================= */

(function () {
  'use strict';

  var ua = navigator.userAgent || '';

  /* file:// 下没有 https，Service Worker 和安装都用不了，直接不初始化 */
  var isFile = location.protocol === 'file:';
  var isStandalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;

  var isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  var isWeChat = /MicroMessenger/i.test(ua);
  var isAndroid = /Android/i.test(ua);

  /* 是不是"装到桌面"这件事真正有意义的设备。
     Chrome 在桌面上也会抛 beforeinstallprompt，如果一视同仁地弹底部条，
     它就正好糊在图表上——桌面用户本来也不需要"添加到桌面"。
     注意不能只看 maxTouchPoints：带触摸屏的笔记本也会 >0（实测 10），
     但人家用的是鼠标。可靠信号是"主指针是不是粗的"+ 窄屏。
     所以：手机/平板弹条，桌面只在顶栏留一个小按钮，愿意装的人自己点。 */
  var isInstallTarget =
    isIOS || isAndroid ||
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    window.innerWidth < 720;

  var DISMISS_KEY = 'zz.pwa.installDismissed';

  var deferredPrompt = null;   // 安卓 Chrome 的安装事件，只能存一次
  var waitedWorker = null;     // 正在等待接管的新版 Service Worker
  var reloading = false;

  /* =========================================================
     一、样式（自己注入，避免动 index.html 里那一大段 CSS）
     ========================================================= */
  function injectStyle() {
    var css = [
      /* ---- 底栏提示 ---- */
      '#zzBar{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));',
      '  max-width:420px;margin:0 auto;z-index:200;display:none;',
      '  background:#fff;border:1px solid rgba(17,24,39,.10);border-radius:12px;',
      '  box-shadow:0 10px 30px rgba(16,24,40,.16),0 2px 6px rgba(16,24,40,.06);',
      '  padding:12px 13px;font-family:var(--font,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);',
      '  animation:zzUp .26s cubic-bezier(.2,.8,.3,1) both}',
      /* 手机上把说明那行收掉，只留标题和按钮：这条固定在底部，太高一屏就没内容了 */
      '@media (max-width:640px){#zzBar{padding:9px 11px;gap:8px}#zzBar .zz-d{display:none}#zzBar .zz-ico{width:28px;height:28px}}',
      '#zzBar.on{display:flex;gap:10px;align-items:flex-start}',
      '@keyframes zzUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){#zzBar.on{animation:none}}',
      '#zzBar .zz-ico{width:32px;height:32px;border-radius:8px;flex:none;',
      '  background:linear-gradient(145deg,#3D6B55,#7BA36F);display:flex;align-items:center;justify-content:center}',
      '#zzBar .zz-ico svg{display:block}',
      '#zzBar .zz-main{flex:1;min-width:0}',
      '#zzBar .zz-t{font-size:13px;font-weight:600;color:#111827;margin:0 0 3px;line-height:1.35}',
      '#zzBar .zz-d{font-size:11.5px;color:#6b7280;line-height:1.6;margin:0}',
      '#zzBar .zz-d b{color:#374151;font-weight:600}',
      '#zzBar .zz-acts{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}',
      '#zzBar button{font-family:inherit;font-size:12px;border-radius:6px;cursor:pointer;',
      '  padding:6px 12px;border:1px solid rgba(17,24,39,.14);background:#fff;color:#111827}',
      '#zzBar button:active{transform:translateY(.5px)}',
      '#zzBar button.zz-primary{background:#3D6B55;border-color:#3D6B55;color:#fff;font-weight:500}',
      '#zzBar button.zz-later{background:transparent;border-color:transparent;color:#9ca3af;padding:6px 8px}',
      '#zzBar .zz-x{flex:none;border:none;background:transparent;color:#9ca3af;font-size:16px;',
      '  line-height:1;padding:2px 4px;cursor:pointer}',
      /* ---- 顶栏安装按钮 ---- */
      '#zzInstallTop{display:none}',
      '#zzInstallTop.on{display:inline-flex}',
      /* 手机上要给底部 Tab 栏让位，否则提示条正好压住导航 */
      '@media (max-width:640px){#zzBar{left:8px;right:8px;bottom:calc(64px + env(safe-area-inset-bottom,0px))}}'
    ].join('\n');

    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  var ICON_LEAF =
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 21V10"/><path d="M12 12c0-3.2 2.4-5.8 5.4-5.8 0 3.2-2.4 5.8-5.4 5.8z"/>' +
    '<path d="M12 15c0-2.8-2-5-4.6-5 0 2.8 2 5 4.6 5z"/></svg>';

  var ICON_DOWNLOAD =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>';

  /* =========================================================
     二、底栏提示
     ========================================================= */
  var barEl = null;

  function bar() {
    if (barEl) return barEl;
    barEl = document.createElement('div');
    barEl.id = 'zzBar';
    barEl.setAttribute('role', 'dialog');
    document.body.appendChild(barEl);
    return barEl;
  }

  /**
   * @param {object} o { title, desc, icon, actions:[{label, primary, onClick}], dismiss }
   */
  function showBar(o) {
    var el = bar();
    var html = '<div class="zz-ico">' + (o.icon || ICON_LEAF) + '</div>' +
               '<div class="zz-main"><p class="zz-t"></p><p class="zz-d"></p>' +
               '<div class="zz-acts"></div></div>';
    el.innerHTML = html;
    el.querySelector('.zz-t').textContent = o.title;
    el.querySelector('.zz-d').innerHTML = o.desc || '';

    var acts = el.querySelector('.zz-acts');
    (o.actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.textContent = a.label;
      if (a.primary) b.className = 'zz-primary';
      if (a.later) b.className = 'zz-later';
      b.onclick = a.onClick;
      acts.appendChild(b);
    });
    if (!o.actions || !o.actions.length) acts.style.display = 'none';

    if (o.dismiss) {
      var x = document.createElement('button');
      x.className = 'zz-x';
      x.innerHTML = '&times;';
      x.setAttribute('aria-label', '关闭');
      x.onclick = o.dismiss;
      el.appendChild(x);
    }
    el.classList.add('on');
    document.body.classList.add('zz-bar-on');
  }

  function hideBar() {
    if (barEl) barEl.classList.remove('on');
    document.body.classList.remove('zz-bar-on');
  }

  function dismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
  }

  function dismissForever() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
    hideBar();
  }

  /* =========================================================
     三、顶栏「安装」按钮
     ========================================================= */
  var topBtn = null;

  function showTopButton() {
    if (topBtn) { topBtn.classList.add('on'); return; }
    var host = document.querySelector('.topbar-r');
    if (!host) return;

    topBtn = document.createElement('button');
    topBtn.className = 'icon-btn on';
    topBtn.id = 'zzInstallTop';
    topBtn.title = '安装到桌面';
    topBtn.setAttribute('aria-label', '安装到桌面');
    topBtn.innerHTML = ICON_DOWNLOAD;
    topBtn.onclick = function () {
      if (deferredPrompt) {
        doInstall();
      } else if (isIOS) {
        showIOSGuide();
      } else if (isWeChat) {
        showWeChatGuide();
      } else {
        showIOSGuide();   // 通用说明兜底
      }
    };
    // 放在刷新按钮左边
    var refresh = host.querySelector('#refreshBtn');
    if (refresh) host.insertBefore(topBtn, refresh);
    else host.appendChild(topBtn);
  }

  function hideTopButton() {
    if (topBtn) topBtn.classList.remove('on');
  }

  /* =========================================================
     四、安装
     ========================================================= */
  function doInstall() {
    if (!deferredPrompt) return;
    var p = deferredPrompt;
    deferredPrompt = null;     // 只能调用一次，用完即弃
    p.prompt();
    p.userChoice.then(function (res) {
      hideTopButton();
      hideBar();
      if (res && res.outcome === 'accepted') {
        // 安装成功后由 appinstalled 收尾
      } else if (res && res.outcome === 'dismissed') {
        dismissForever();      // 用户明确拒绝过，就不再反复问
      }
    }).catch(function () {});
  }

  function offerInstall() {
    if (isStandalone || dismissed()) return;

    showTopButton();

    // 用户在微信里：说清楚该去哪儿
    if (isWeChat) {
      showBar({
        title: '想装到桌面，先换个浏览器',
        desc: '微信内置浏览器装不了。点右上角 <b>···</b> → <b>在浏览器打开</b>，' +
              '再从那个浏览器里安装。',
        dismiss: dismissForever,
        actions: [{ label: '知道了', primary: true, onClick: dismissForever }]
      });
      return;
    }

    // iPhone：没有安装接口，只能教步骤
    if (isIOS) {
      showBar({
        title: '装到桌面，像 App 一样打开',
        desc: '在 <b>Safari</b> 里点底部 <b>分享</b> 按钮，往下找 <b>添加到主屏幕</b>。',
        icon: ICON_LEAF,
        dismiss: dismissForever,
        actions: [
          { label: '看详细步骤', primary: true, onClick: showIOSGuide },
          { label: '以后再说', later: true, onClick: dismissForever }
        ]
      });
      return;
    }

    // 安卓：等 beforeinstallprompt 拿到调用资格
    if (deferredPrompt) {
      // 别一进页面就糊在首屏上，等用户看两眼再出现
      setTimeout(function () {
        if (isStandalone || dismissed() || !deferredPrompt) return;
        showBar({
          title: '装到桌面，下次一秒打开',
          desc: '添加后有自己的图标，不再需要在浏览器里找网址。占用不到 1 MB。',
          dismiss: dismissForever,
          actions: [
            { label: '安装', primary: true, onClick: doInstall },
            { label: '以后再说', later: true, onClick: dismissForever }
          ]
        });
      }, 3500);
    }
  }

  function showIOSGuide() {
    showBar({
      title: '添加到主屏幕（iPhone / iPad）',
      desc: '1. 确认用的是 <b>Safari</b><br>' +
            '2. 点屏幕底部中间的 <b>分享</b> 图标（方框向上箭头）<br>' +
            '3. 在列表里选 <b>添加到主屏幕</b><br>' +
            '4. 右上角点 <b>添加</b>',
      dismiss: hideBar,
      actions: [{ label: '明白了', primary: true, onClick: hideBar }]
    });
  }

  function showWeChatGuide() {
    showBar({
      title: '请先在浏览器中打开',
      desc: '点右上角 <b>···</b>，选择 <b>在浏览器打开</b>，然后就能安装到桌面了。',
      dismiss: hideBar,
      actions: [{ label: '知道了', primary: true, onClick: hideBar }]
    });
  }

  /* =========================================================
     五、新版本提示
     ========================================================= */
  function offerUpdate(worker) {
    waitedWorker = worker;
    showBar({
      title: '有新版本',
      desc: '更新只影响界面和规则，不影响你已保存的地块。',
      dismiss: hideBar,
      actions: [{
        label: '立即更新',
        primary: true,
        onClick: function () {
          if (!waitedWorker) return;
          reloading = true;
          waitedWorker.postMessage({ type: 'SKIP_WAITING' });
        }
      }]
    });
  }

  /* =========================================================
     六、断网提示
     ========================================================= */
  function offlineNotice() {
    if (isStandalone || dismissed()) { /* 断网也要提示，不受安装关闭影响 */ }
    showBar({
      title: '当前没有网络',
      desc: '界面还能用，但天气数据取不到——<b>不要照着上一次的结论下地</b>。' +
            '恢复网络后会自动重新加载。',
      dismiss: hideBar,
      actions: [{ label: '知道了', primary: true, onClick: hideBar }]
    });
  }

  /* =========================================================
     七、注册 Service Worker
     ========================================================= */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (isFile) return;                     // file:// 下注册必然失败
    if (!window.isSecureContext) return;    // http 下浏览器不允许

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).then(function (reg) {
        // 已经有一个新版本在等着（上次没更新成）
        if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              offerUpdate(nw);
            }
          });
        });

        // 回到页面时检查一次更新（手机上 App 常驻后台，靠这个拿到新版）
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') reg.update().catch(function () {});
        });
      }).catch(function () {
        /* 注册失败不影响主功能：只是不能离线打开，也不能安装 */
      });
    });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!reloading) return;    // 只在自己点了「立即更新」时刷新
      location.reload();
    });
  }

  /* =========================================================
     八、启动
     ========================================================= */
  function boot() {
    if (document.documentElement) {
      document.documentElement.classList.add(isStandalone ? 'zz-standalone' : 'zz-browser');
    }

    registerSW();
    injectStyle();

    if (isStandalone) return;   // 已经装好了，不用再提示安装

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();       // 拦掉浏览器自带的迷你条，改用我们自己的
      deferredPrompt = e;
      // 桌面端只亮顶栏图标，不弹底部条（会挡住图表）
      if (isInstallTarget) offerInstall();
      else showTopButton();
    });

    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      hideTopButton();
      hideBar();
    });

    // iOS / 微信没有 beforeinstallprompt，延迟一点直接给指引
    if (isIOS || isWeChat) {
      setTimeout(offerInstall, 2500);
    }

    // 断网 / 恢复
    window.addEventListener('offline', offlineNotice);
    window.addEventListener('online', function () {
      hideBar();
      var el = bar();
      if (el && el.querySelector('.zz-t') && el.querySelector('.zz-t').textContent === '当前没有网络') {
        showBar({
          title: '网络已恢复',
          desc: '正在重新获取天气数据…',
          dismiss: hideBar,
          actions: []
        });
        setTimeout(hideBar, 2200);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
