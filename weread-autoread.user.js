// ==UserScript==
// @name         微信读书自动阅读 · 自适应版
// @namespace    https://github.com/local/weread-autoread
// @version      1.1.1
// @description  微信读书网页版自动滚动阅读。默认仅滚动不翻页，适合 PDF 扫描版；后台防节流；自带诊断。仅在 weread.qq.com 生效。
// @author       K
// @match        https://weread.qq.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 一、配置
     * ============================================================ */

    const DEFAULTS = {
        enabled: false,
        speed: 3,              // 每次滚动像素
        interval: 60,          // 滚动间隔毫秒
        pageGap: 900,          // 翻页后等待毫秒
        maxWait: 20000,        // 单页最长停留毫秒，超时强制翻页
        pauseOnSelect: true,   // 选中文字时暂停
        pauseOnManual: true,   // 手动滚动后暂停
        strategy: 'auto',      // auto / pagedown / arrow / space / click
        scrollOnly: true,      // 仅滚动不翻页。PDF 扫描版是连续长流，滚到底就是读完
        panelVisible: true
    };

    const store = {
        get(key) {
            try {
                const v = GM_getValue(key, DEFAULTS[key]);
                return v === undefined ? DEFAULTS[key] : v;
            } catch (e) {
                return DEFAULTS[key];
            }
        },
        set(key, value) {
            try { GM_setValue(key, value); } catch (e) { /* 忽略 */ }
        }
    };

    const cfg = {};
    Object.keys(DEFAULTS).forEach(k => { cfg[k] = store.get(k); });
    function save() { Object.keys(cfg).forEach(k => store.set(k, cfg[k])); }

    /* ============================================================
     * 二、工具
     * ============================================================ */

    function fireKey(key, keyCode) {
        const ev = new KeyboardEvent('keydown', {
            key: key,
            code: key,
            keyCode: keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(ev);
        document.body.dispatchEvent(ev);
        window.dispatchEvent(ev);
    }

    // 带坐标的点击。微信读书的按钮处理器会检查 clientX，坐标为 0 会被直接忽略。
    function clickAt(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const ev = document.createEvent('MouseEvents');
        ev.initMouseEvent('click', true, true, window, 1, x, y, x, y,
            false, false, false, false, 0, null);
        el.dispatchEvent(ev);
        return true;
    }

    /* ============================================================
     * 三、滚动容器探测
     * v1.0 只看 overflow 样式，结果在微信读书上全部落空，兜底到了 HTML。
     * v1.1 改成实测：真去滚 1px，看它动不动。只有真能滚的才算数。
     * ============================================================ */

    function probeScrollables() {
        const list = [];
        const seen = [];
        const push = (el) => {
            if (!el) return;
            if (seen.indexOf(el) >= 0) return;
            seen.push(el);
            list.push(el);
        };
        push(document.scrollingElement);
        push(document.documentElement);
        push(document.body);
        const all = document.querySelectorAll('div, section, main, article');
        for (let i = 0; i < all.length; i++) push(all[i]);

        const out = [];
        for (let i = 0; i < list.length; i++) {
            const el = list[i];
            const diff = el.scrollHeight - el.clientHeight;
            if (diff < 40) continue;
            // 实测滚动 1px，看是否真的生效（overflow 样式会说谎）
            const before = el.scrollTop;
            let moved = false;
            try {
                el.scrollTop = before + 1;
                moved = el.scrollTop !== before;
                el.scrollTop = before;
            } catch (e) {
                moved = false;
            }
            out.push({ el: el, diff: diff, moved: moved });
        }
        out.sort((a, b) => {
            if (a.moved !== b.moved) return a.moved ? -1 : 1;
            return b.diff - a.diff;
        });
        return out;
    }

    let scroller = null;
    function getScroller() {
        if (!scroller || !document.contains(scroller) ||
            scroller.scrollHeight - scroller.clientHeight < 40) {
            const found = probeScrollables();
            scroller = found.length ? found[0].el
                : (document.scrollingElement || document.documentElement);
        }
        return scroller;
    }

    function atBottom() {
        const el = getScroller();
        return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    }

    function progressPct() {
        const el = getScroller();
        const total = el.scrollHeight - el.clientHeight;
        if (total <= 0) return 0;
        return Math.min(100, (el.scrollTop / total) * 100);
    }

    // 按当前速度估算还要多久滚完，方便判断今晚来不来得及
    function remainMs() {
        const el = getScroller();
        const left = (el.scrollHeight - el.clientHeight) - el.scrollTop;
        const perMs = cfg.speed / cfg.interval;
        if (perMs <= 0 || left <= 0) return 0;
        return left / perMs;
    }

    /* ============================================================
     * 四、翻页指纹
     * v1.0 把 scrollTop 混进指纹，导致"滚一屏"被误判成"翻页成功"。
     * v1.1 只看视口顶部真实显示的文字：翻页/换章时它必然变化，
     * 单纯滚动几像素则不会。
     * ============================================================ */

    function viewTopText() {
        let node = null;
        try {
            node = document.elementFromPoint(Math.round(window.innerWidth / 2), 80);
        } catch (e) {
            node = null;
        }
        if (!node) return '';
        return (node.innerText || node.textContent || '').trim().slice(0, 60);
    }

    function fingerprint() {
        return viewTopText() + '||' + getScroller().scrollHeight;
    }

    /* ============================================================
     * 五、翻页策略
     * v1.1 把 PageDown 提到首位：v1.0 的诊断显示它是唯一即时生效的。
     * 该结论当时不可信（指纹含 scrollTop），但 2026-08 有同类脚本
     * 专门把翻页键从 ArrowRight 改成 PageDown，侧面支持这个排序。
     * ============================================================ */

    function findNextButton() {
        const selectors = [
            '.readerFooter_button',
            '[class*="readerFooter"] [class*="button"]',
            '[class*="readerTopBar"] [class*="button"]',
            '[class*="footer"] [class*="button"]',
            '[class*="Footer"] [class*="button"]'
        ];
        for (let i = 0; i < selectors.length; i++) {
            const els = document.querySelectorAll(selectors[i]);
            for (let j = 0; j < els.length; j++) {
                const txt = (els[j].innerText || '').trim();
                if (txt.indexOf('下一页') >= 0 || txt.indexOf('下一章') >= 0) return els[j];
            }
        }
        // 类名体系整体换过之后，退化成按文本找
        const all = document.querySelectorAll('button, div, span, a');
        for (let i = 0; i < all.length; i++) {
            const t = (all[i].innerText || '').trim();
            if (t === '下一页' || t === '下一章' || t === '下一节') return all[i];
        }
        return null;
    }

    const STRATEGIES = {
        pagedown: { label: 'PageDown', run: () => fireKey('PageDown', 34) },
        arrow: { label: '方向键右', run: () => fireKey('ArrowRight', 39) },
        space: { label: '空格', run: () => fireKey(' ', 32) },
        click: { label: '点击按钮', run: () => clickAt(findNextButton()) }
    };
    const STRATEGY_ORDER = ['pagedown', 'arrow', 'space', 'click'];

    function getStrategyKeys() {
        return cfg.strategy === 'auto' ? STRATEGY_ORDER.slice() : [cfg.strategy];
    }

    let strategyIndex = 0;
    let lastStrategy = '-';
    let failStreak = 0;

    function turnPage() {
        const keys = getStrategyKeys();
        const key = keys[strategyIndex % keys.length];
        STRATEGIES[key].run();
        lastStrategy = STRATEGIES[key].label;
        return key;
    }

    function verifyAndRotate(changed) {
        if (changed) {
            strategyIndex = 0;
            failStreak = 0;
            return;
        }
        failStreak++;
        // 连续两次判定失败才换策略，避免偶发误判导致乱换
        if (cfg.strategy === 'auto' && failStreak >= 2) {
            strategyIndex++;
            failStreak = 0;
        }
    }

    /* ============================================================
     * 六、定时器
     * 后台标签页会把 setInterval 节流到约每分钟一次，刷时长就废了。
     * 放进 Worker 可绕过；CSP 拦截时退回页面内定时器并如实标注。
     * ============================================================ */

    const WORKER_SRC = [
        'var t=null;',
        'self.onmessage=function(e){',
        '  var d=e.data;',
        '  if(d.cmd==="start"){',
        '    if(t)clearInterval(t);',
        '    t=setInterval(function(){self.postMessage("tick");},d.ms);',
        '  }else if(d.cmd==="stop"){clearInterval(t);t=null;}',
        '};'
    ].join('');

    let worker = null;
    let fallbackTimer = null;
    let tickSource = '未启动';

    function ensureWorker() {
        if (worker || fallbackTimer) return;
        try {
            const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            worker = new Worker(url);
            URL.revokeObjectURL(url);
            worker.onmessage = (e) => { if (e.data === 'tick') tick(); };
            worker.onerror = () => { switchToFallback(); };
            tickSource = 'Worker（后台可用）';
        } catch (err) {
            switchToFallback();
        }
    }

    function switchToFallback() {
        if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
        if (fallbackTimer) return;
        fallbackTimer = setInterval(tick, Math.max(cfg.interval, 50));
        tickSource = '页面定时器（后台被节流）';
        updatePanel();
    }

    function startTimer() {
        if (worker) {
            worker.postMessage({ cmd: 'stop' });
            worker.postMessage({ cmd: 'start', ms: Math.max(cfg.interval, 16) });
            return;
        }
        if (fallbackTimer) {
            clearInterval(fallbackTimer);
            fallbackTimer = setInterval(tick, Math.max(cfg.interval, 50));
        }
    }

    function stopTimer() {
        if (worker) worker.postMessage({ cmd: 'stop' });
        if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    }

    /* ============================================================
     * 七、主循环
     * ============================================================ */

    let lastScroll = 0;
    let lastTurn = 0;
    let manualPauseUntil = 0;
    let sessionStart = 0;
    let pendingFp = '';
    let pendingKey = '';
    let pendingAt = 0;
    let waitingPage = false;

    function tick() {
        if (!cfg.enabled) { stopTimer(); return; }
        if (!isReaderPage()) return;

        const now = Date.now();
        if (now < manualPauseUntil) return;
        if (cfg.pauseOnSelect && hasSelection()) return;

        if (waitingPage) {
            if (now - pendingAt > cfg.pageGap) {
                const changed = pendingFp !== fingerprint();
                verifyAndRotate(changed);
                waitingPage = false;
                lastTurn = now;
                if (changed) {
                    scroller = null;
                    const el = getScroller();
                    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2 && el.scrollTop > 0) {
                        el.scrollTop = 0;
                    }
                    log('翻页成功 · ' + STRATEGIES[pendingKey].label);
                } else if (cfg.strategy === 'auto') {
                    log('翻页未生效 · 换策略');
                }
            }
            if (now - lastTurn > cfg.maxWait) waitingPage = false;
            updatePanel();
            return;
        }

        if (atBottom()) {
            // PDF 扫描版是连续长流，到末尾就静静停下。
            // 如果不加这个判断，会去按 PageDown，在扫描版上可能造成意外跳转。
            if (cfg.scrollOnly) { finish('已滚到末尾'); return; }
            if (now - lastTurn > cfg.maxWait) { doTurnPage(now); return; }
            doTurnPage(now);
            return;
        }

        if (now - lastScroll >= cfg.interval) {
            getScroller().scrollTop += cfg.speed;
            lastScroll = now;
        }
        updatePanel();
    }

    function finish(msg) {
        cfg.enabled = false;
        save();
        stopTimer();
        waitingPage = false;
        log(msg);
        updatePanel();
    }

    function doTurnPage(now) {
        pendingFp = fingerprint();
        pendingKey = turnPage();
        pendingAt = now;
        waitingPage = true;
        lastTurn = now;
        updatePanel();
    }

    function isReaderPage() {
        return location.pathname.indexOf('/web/reader/') >= 0;
    }

    function hasSelection() {
        const s = window.getSelection();
        return s && s.toString().trim().length > 0;
    }

    /* ============================================================
     * 八、界面
     * ============================================================ */

    const UI = {};
    let uiReady = false;
    let logMsg = '';
    let logUntil = 0;

    function buildUI() {
        if (uiReady) return;
        uiReady = true;

        const css = document.createElement('style');
        css.textContent = [
            '.war-panel{position:fixed;right:16px;bottom:16px;z-index:999998;',
            'width:250px;background:#fff;border:1px solid #e3e3e3;border-radius:10px;',
            'box-shadow:0 4px 16px rgba(0,0,0,.12);font:13px/1.6 -apple-system,"Microsoft YaHei",sans-serif;',
            'color:#333;user-select:none;}',
            '.war-head{padding:10px 12px;cursor:pointer;display:flex;align-items:center;',
            'justify-content:space-between;border-bottom:1px solid #eee;}',
            '.war-title{font-weight:600;font-size:13px;}',
            '.war-toggle{font-size:12px;padding:2px 10px;border-radius:12px;border:none;cursor:pointer;',
            'background:#eee;color:#666;}',
            '.war-toggle.on{background:#07c160;color:#fff;}',
            '.war-body{padding:10px 12px 12px;}',
            '.war-hidden{display:none;}',
            '.war-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}',
            '.war-row span:first-child{color:#888;font-size:12px;}',
            '.war-row b{font-weight:500;font-size:12px;font-family:Consolas,monospace;word-break:break-all;}',
            '.war-ctl{margin-bottom:10px;}',
            '.war-ctl label{display:block;font-size:12px;color:#888;margin-bottom:2px;}',
            '.war-ctl input[type=range]{width:100%;}',
            '.war-ctl select{width:100%;padding:3px;font-size:12px;}',
            '.war-btns{display:flex;gap:6px;margin-top:10px;}',
            '.war-btns button{flex:1;padding:6px 0;font-size:12px;border:1px solid #ddd;',
            'background:#fafafa;border-radius:6px;cursor:pointer;color:#555;}',
            '.war-btns button:hover{background:#f0f0f0;}',
            '.war-tip{margin-top:10px;font-size:11px;color:#aaa;line-height:1.5;}'
        ].join('');
        document.head.appendChild(css);

        UI.root = document.createElement('div');
        UI.root.className = 'war-panel';
        UI.root.innerHTML = [
            '<div class="war-head">',
            '  <span class="war-title">自动阅读 v1.1.1</span>',
            '  <button class="war-toggle">未开启</button>',
            '</div>',
            '<div class="war-body">',
            '  <div class="war-row"><span>状态</span><b class="war-state">待机</b></div>',
            '  <div class="war-row"><span>滚动容器</span><b class="war-sc">-</b></div>',
            '  <div class="war-row"><span>进度</span><b class="war-prog">0%</b></div>',
            '  <div class="war-row"><span>翻页方式</span><b class="war-str">-</b></div>',
            '  <div class="war-row"><span>定时器</span><b class="war-tick">-</b></div>',
            '  <div class="war-row"><span>本次时长</span><b class="war-time">00:00</b></div>',
            '  <div class="war-ctl"><label>速度 <i class="war-v1"></i> px/次</label>',
            '    <input type="range" class="war-speed" min="1" max="30" step="1"></div>',
            '  <div class="war-ctl"><label>间隔 <i class="war-v2"></i> ms</label>',
            '    <input type="range" class="war-intv" min="16" max="300" step="4"></div>',
            '  <div class="war-ctl"><label>翻页策略</label>',
            '    <select class="war-stgy">',
            '      <option value="auto">自动（逐个尝试）</option>',
            '      <option value="pagedown">PageDown</option>',
            '      <option value="arrow">方向键右</option>',
            '      <option value="space">空格</option>',
            '      <option value="click">点击按钮</option>',
            '    </select></div>',
            '  <div class="war-only-ctl"><label><input type="checkbox" class="war-only">',
            '    仅滚动，不翻页（PDF 扫描版选这个）</label></div>',
            '  <div class="war-btns">',
            '    <button class="war-diag">自检诊断</button>',
            '    <button class="war-hide">隐藏</button>',
            '  </div>',
            '  <div class="war-tip">快捷键 Ctrl+Enter 开关。诊断会真的翻页，建议在没在读的位置跑。</div>',
            '</div>'
        ].join('');
        document.body.appendChild(UI.root);

        const q = (s) => UI.root.querySelector(s);
        UI.body = q('.war-body');
        UI.toggle = q('.war-toggle');
        UI.state = q('.war-state');
        UI.sc = q('.war-sc');
        UI.prog = q('.war-prog');
        UI.str = q('.war-str');
        UI.tick = q('.war-tick');
        UI.time = q('.war-time');
        UI.v1 = q('.war-v1');
        UI.v2 = q('.war-v2');
        UI.speed = q('.war-speed');
        UI.intv = q('.war-intv');
        UI.stgy = q('.war-stgy');
        UI.only = q('.war-only');

        UI.only.checked = cfg.scrollOnly;
        UI.stgy.disabled = cfg.scrollOnly;
        UI.only.onchange = (e) => {
            cfg.scrollOnly = e.target.checked;
            UI.stgy.disabled = cfg.scrollOnly;
            save();
        };

        UI.speed.value = cfg.speed;
        UI.intv.value = cfg.interval;
        UI.stgy.value = cfg.strategy;
        UI.v1.textContent = cfg.speed;
        UI.v2.textContent = cfg.interval;

        UI.toggle.onclick = () => setEnabled(!cfg.enabled);
        q('.war-hide').onclick = () => { UI.body.classList.toggle('war-hidden'); };
        q('.war-diag').onclick = runDiagnose;

        UI.speed.oninput = (e) => {
            cfg.speed = parseInt(e.target.value, 10);
            UI.v1.textContent = cfg.speed; save();
        };
        UI.intv.oninput = (e) => {
            cfg.interval = parseInt(e.target.value, 10);
            UI.v2.textContent = cfg.interval; save();
            if (cfg.enabled) startTimer();
        };
        UI.stgy.onchange = (e) => {
            cfg.strategy = e.target.value; strategyIndex = 0; failStreak = 0; save();
        };

        UI.root.addEventListener('wheel', () => { manualPauseUntil = Date.now() + 1500; });
        getScroller().addEventListener('wheel', () => { manualPauseUntil = Date.now() + 1500; });

        updatePanel();
    }

    function fmtTime(ms) {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const pad = (n) => (n < 10 ? '0' + n : '' + n);
        return (h > 0 ? pad(h) + ':' : '') + pad(m % 60) + ':' + pad(s % 60);
    }

    function shortName(el) {
        if (el === document.scrollingElement || el === document.documentElement) return 'HTML(window)';
        if (el === document.body) return 'BODY';
        const c = String(el.className || '').split(' ')[0];
        return el.tagName.toLowerCase() + (c ? '.' + c : '');
    }

    function updatePanel() {
        if (!uiReady) return;
        UI.toggle.textContent = cfg.enabled ? '运行中' : '未开启';
        UI.toggle.className = 'war-toggle' + (cfg.enabled ? ' on' : '');
        UI.state.textContent = Date.now() < logUntil ? logMsg
            : (waitingPage ? '翻页中' : (cfg.enabled ? '阅读中' : '待机'));
        UI.sc.textContent = shortName(getScroller());
        UI.prog.textContent = progressPct().toFixed(1) + '% · 约剩 ' + fmtTime(remainMs());
        UI.str.textContent = lastStrategy + (cfg.strategy === 'auto' && strategyIndex > 0
            ? '（第' + (strategyIndex + 1) + '顺位）' : '');
        UI.tick.textContent = tickSource;
        UI.time.textContent = cfg.enabled && sessionStart ? fmtTime(Date.now() - sessionStart) : '00:00';
    }

    function log(msg) {
        logMsg = msg;
        logUntil = Date.now() + 1500;
        if (uiReady) UI.state.textContent = msg;
    }

    /* ============================================================
     * 九、自检诊断
     * v1.0 的同步比较判不出异步加载，v1.1 改成逐个等待后再比较。
     * 另外一个重要用途：把当前真实 DOM 结构导出，据此重建选择器。
     * ============================================================ */

    function collectReaderClasses() {
        const map = {};
        const els = document.querySelectorAll('[class*="reader"]');
        for (let i = 0; i < els.length; i++) {
            const cs = String(els[i].className || '').split(/\s+/);
            for (let j = 0; j < cs.length; j++) {
                if (cs[j].indexOf('reader') !== 0) continue;
                map[cs[j]] = (map[cs[j]] || 0) + 1;
            }
        }
        return Object.keys(map).sort((a, b) => map[b] - map[a]).slice(0, 40)
            .map(k => '  ' + k + ' ×' + map[k]);
    }

    function runDiagnose() {
        const lines = [];
        lines.push('=== 微信读书自动阅读 · 诊断报告 v1.1 ===');
        lines.push('时间: ' + new Date().toLocaleString());
        lines.push('URL: ' + location.href);
        lines.push('是否阅读页: ' + isReaderPage());
        lines.push('视口: ' + window.innerWidth + '×' + window.innerHeight);
        lines.push('');

        lines.push('[可滚动候选 TOP8]');
        const found = probeScrollables().slice(0, 8);
        found.forEach((o, i) => {
            lines.push('  ' + (i + 1) + '. ' + shortName(o.el) +
                '  sH=' + o.el.scrollHeight + ' cH=' + o.el.clientHeight +
                ' diff=' + o.diff + ' 实测可滚:' + (o.moved ? '是' : '否') +
                ' overflowY=' + getComputedStyle(o.el).overflowY);
        });
        if (!found.length) lines.push('  （未找到任何可滚动元素）');
        lines.push('');
        lines.push('[当前选中容器] ' + shortName(getScroller()));
        lines.push('  scrollTop=' + getScroller().scrollTop +
            ' 进度=' + progressPct().toFixed(1) + '%');
        lines.push('');

        lines.push('[reader* 类名清单]');
        const cl = collectReaderClasses();
        lines.push(cl.length ? cl.join('\n') : '  （无，类名体系可能整体换过）');
        lines.push('');

        lines.push('[翻页按钮查找]');
        ['readerFooter_button', 'readerFooter', 'readerTopBar', '下一页', '下一章'].forEach(k => {
            const n = document.querySelectorAll('[class*="' + k + '"]').length;
            lines.push('  类选择器 *' + k + '*: ' + n + ' 个');
        });
        const btn = findNextButton();
        lines.push('  按文本找到的按钮: ' + (btn ? shortName(btn) + ' 文本="' +
            (btn.innerText || '').trim() + '"' : '未找到'));
        lines.push('');

        lines.push('[视口顶部文本] ' + viewTopText().replace(/\n/g, ' '));
        lines.push('');

        finishDiagnose(lines);
    }

    // 逐个实测策略，每个之间等待，这样异步加载的翻页也测得出来
    function finishDiagnose(lines) {
        // 仅滚动模式下，实测策略会真的翻页，可能把 PDF 的位置翻乱，直接不测
        if (cfg.scrollOnly) {
            lines.push('[翻页策略实测] 已跳过：仅滚动模式下实测会真翻页，会把当前位置翻乱。');
            lines.push('  如需实测，先取消勾选「仅滚动，不翻页」。');
            lines.push('');
            lines.push('[运行环境]');
            lines.push('  定时器来源: ' + tickSource);
            lines.push('  页面可见: ' + (document.visibilityState === 'visible'
                ? '是' : '否（后台标签会被节流）'));
            lines.push('  速度: ' + cfg.speed + 'px/' + cfg.interval + 'ms' +
                '  仅滚动: 是');
            lines.push('====================================');
            outputDiagnose(lines.join('\n'));
            return;
        }
        lines.push('[翻页策略逐个实测] 每个等待 900ms');
        const results = [];
        let idx = 0;
        const el = getScroller();

        function testOne() {
            if (idx >= STRATEGY_ORDER.length) {
                results.forEach(r => {
                    lines.push('  ' + r.label +
                        ' → 位移 ' + (r.dTop >= 0 ? '+' : '') + Math.round(r.dTop) +
                        ' 高度 ' + (r.dH >= 0 ? '+' : '') + r.dH +
                        ' 顶部文本变化:' + (r.textChanged ? '是' : '否') +
                        ' → ' + (r.ok ? '翻页生效' : '未见翻页'));
                });
                lines.push('');
                lines.push('[运行环境]');
                lines.push('  定时器来源: ' + tickSource);
                lines.push('  页面可见: ' + (document.visibilityState === 'visible'
                    ? '是' : '否（后台标签会被节流）'));
                lines.push('  当前策略: ' + cfg.strategy + '  速度: ' + cfg.speed +
                    'px/' + cfg.interval + 'ms');
                lines.push('====================================');
                outputDiagnose(lines.join('\n'));
                return;
            }
            const k = STRATEGY_ORDER[idx];
            const bTop = el.scrollTop;
            const bH = el.scrollHeight;
            const bText = viewTopText();
            STRATEGIES[k].run();
            setTimeout(() => {
                const cur = getScroller();
                const aTop = cur.scrollTop;
                const aH = cur.scrollHeight;
                const aText = viewTopText();
                const dTop = aTop - bTop;
                const dH = aH - bH;
                const textChanged = bText !== aText;
                results.push({
                    label: STRATEGIES[k].label,
                    dTop: dTop,
                    dH: dH,
                    textChanged: textChanged,
                    ok: textChanged || dH !== 0
                });
                idx++;
                testOne();
            }, 900);
        }
        testOne();
    }

    function outputDiagnose(text) {
        console.log(text);
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        alert(text + '\n\n' + (ok ? '已复制到剪贴板，直接粘贴给 AI 即可。' : '请手动从控制台复制。'));
    }

    /* ============================================================
     * 十、开关与快捷键
     * ============================================================ */

    function setEnabled(on) {
        cfg.enabled = on;
        save();
        if (on) {
            sessionStart = Date.now();
            ensureWorker();
            startTimer();
        } else {
            stopTimer();
            waitingPage = false;
        }
        updatePanel();
    }

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            setEnabled(!cfg.enabled);
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') scroller = null;
    });

    setInterval(() => { if (cfg.enabled) updatePanel(); }, 1000);

    /* ============================================================
     * 十一、启动
     * ============================================================ */

    let tries = 0;
    const boot = setInterval(() => {
        tries++;
        if ((isReaderPage() && document.body) || tries > 40) {
            clearInterval(boot);
            if (isReaderPage()) buildUI();
        }
    }, 250);

    try {
        GM_registerMenuCommand('导出诊断报告', runDiagnose);
    } catch (e) { /* 忽略 */ }
})();
