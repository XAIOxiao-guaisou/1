(function () {
    'use strict';
    const CONFIG = {
        MIN_SIZE: 200,
        // 白名单容器：Gemini Angular 组件，只有在这些里面的图才是对话生成/引用图
        // <message-content> 是对话气泡内容、<model-response>/<user-query> 是角色标签
        ALLOWED_CONTAINERS: 'message-content,model-response,user-query,[class*="message-content" i]',
        // 允许的 URL scheme：Gemini 用 blob: URL 渲染生成图；直链也接受
        ALLOWED_SCHEMES: ['blob:', 'http:', 'https:'],
        // 明确拒绝的容器（避免白名单疏漏，双重保险）
        EXCLUDE_CONTAINERS: 'header,nav,[aria-label*="account" i],[class*="avatar" i],[class*="user-image" i],[class*="profile-picture" i],[class*="user-button" i]'
    };
    // 开启后会把过滤决策打印到 console + 左上角浮动面板，便于定位图像捕获问题。
    // 默认开启；确认修复无误后可设置 localStorage.setItem('GEMINI_DL_DEBUG', '0') 关闭。
    const DEBUG = (() => {
        try { return localStorage.getItem('GEMINI_DL_DEBUG') !== '0'; }
        catch { return true; }
    })();
    // 浮动调试面板
    let debugPanel = null;
    function getDebugPanel() {
        if (!DEBUG) return null;
        if (debugPanel && debugPanel.isConnected) return debugPanel;
        debugPanel = document.createElement('div');
        debugPanel.id = 'gemini-dl-debug';
        debugPanel.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647;background:rgba(0,0,0,0.85);color:#0f0;font:11px/1.4 Consolas,monospace;padding:8px;border-radius:6px;max-width:480px;max-height:280px;overflow-y:auto;pointer-events:auto;border:1px solid #0f0;';
        debugPanel.innerHTML = '<div style="color:#ff0;font-weight:bold;margin-bottom:4px;">[Gemini-DL DEBUG] 点击可关闭</div>';
        debugPanel.onclick = () => { debugPanel.remove(); debugPanel = null; };
        (document.body || document.documentElement).appendChild(debugPanel);
        return debugPanel;
    }
    const dlog = (...args) => {
        if (!DEBUG) return;
        console.log('[Gemini-DL]', ...args);
        const panel = getDebugPanel();
        if (!panel) return;
        const line = document.createElement('div');
        line.textContent = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 240);
        panel.appendChild(line);
        panel.scrollTop = panel.scrollHeight;
    };
    const IOPAINT_URL = 'http://127.0.0.1:8080';
    const SHARPEN_WORKER_URL = chrome.runtime.getURL('sharpen.worker.js');

    // URL scheme 检查（blob/http/https 都允许；data: 等拒绝）
    function isAllowedScheme(url) {
        return CONFIG.ALLOWED_SCHEMES.some(s => url.startsWith(s));
    }

    // DOM 白名单：必须在 Gemini 对话消息容器内
    function isInAllowedContainer(node) {
        if (!node || !node.closest) return false;
        return !!node.closest(CONFIG.ALLOWED_CONTAINERS);
    }

    // DOM 黑名单：即使在消息容器内，也排除头像/账号按钮等明显非生成图元素
    function isInExcludedContainer(node) {
        if (!node || !node.closest) return false;
        return !!node.closest(CONFIG.EXCLUDE_CONTAINERS);
    }
    // 把锐化交给 Worker；创建失败（CSP / 旧内核）时回退主线程
    function sharpenInWorker(imageData, gScale) {
        return new Promise((resolve) => {
            let worker;
            try { worker = new Worker(SHARPEN_WORKER_URL); }
            catch { resolve(null); return; }
            const timeout = setTimeout(() => {
                try { worker.terminate(); } catch { /* ignore */ }
                resolve(null);
            }, 15000);
            worker.onmessage = (e) => {
                clearTimeout(timeout);
                worker.terminate();
                if (e.data?.error || !e.data?.buffer) { resolve(null); return; }
                resolve(new ImageData(new Uint8ClampedArray(e.data.buffer), imageData.width, imageData.height));
            };
            worker.onerror = () => { clearTimeout(timeout); worker.terminate(); resolve(null); };
            // transferable 零拷贝
            worker.postMessage({
                buffer: imageData.data.buffer,
                width:  imageData.width,
                height: imageData.height,
                gScale
            }, [imageData.data.buffer]);
        });
    }
    // 主线程降级版本：与 worker 算法完全一致，仅用于兼容兜底。
    function sharpenInline(imageData, gScale) {
        const d = imageData.data, w = imageData.width, h = imageData.height;
        const src = new Uint8ClampedArray(d), w4 = w * 4;
        const mix = gScale >= 4 ? 0.8 : 0.6;
        const center = 4 * mix + 1, side = -mix;
        for (let y = 1; y < h - 1; y++) {
            let p = y * w4 + 4, pUp = p - w4, pDown = p + w4;
            for (let x = 1; x < w - 1; x++) {
                for (let c = 0; c < 3; c++) {
                    const v = src[p + c] * center + src[p - 4 + c] * side + src[p + 4 + c] * side + src[pUp + c] * side + src[pDown + c] * side;
                    const diff = v - src[p + c];
                    d[p + c] = src[p + c] + diff * 1.1;
                }
                p += 4; pUp += 4; pDown += 4;
            }
        }
        return imageData;
    }
    // 简易 LRU：长会话下去重集合会无限增长，按 Map 插入顺序裁剪即可。
    class LRUSet {
        constructor(capacity = 1000) { this.capacity = capacity; this.map = new Map(); }
        has(k) { return this.map.has(k); }
        add(k) {
            if (this.map.has(k)) this.map.delete(k);
            this.map.set(k, 1);
            if (this.map.size > this.capacity) {
                this.map.delete(this.map.keys().next().value);
            }
        }
        delete(k) { this.map.delete(k); }
    }
    const uploadedSet = new LRUSet(1000);
    const processingSet = new LRUSet(100);
    async function checkIOPaintStatus() {
        try {
            const r = await fetch(`${IOPAINT_URL}/api/v1/model`, {
                signal: AbortSignal.timeout(3000)
            });
            return r.ok;
        } catch { return false; }
    }
    let downloadCount = 0;
    const cleanUrl = u => {
        try {
            if (u.includes('googleusercontent.com')) return u.split('=')[0];
            return u.split('?')[0];
        } catch { return u; }
    };
    // 仅 googleusercontent 支持 =sN 尺寸参数；其他域（例如 gemini.google.com）保持原样。
    const buildHiResUrl = cleanedUrl =>
        cleanedUrl.includes('googleusercontent.com') ? cleanedUrl + '=s4096' : cleanedUrl;
    // Gemini 水印在图片右下，包围盒由 cutRight × cutBottom 决定。
    // 与 options.html 文档保持一致：圆心距右 cw/2、距下 ch/2；半径 = min(cw, ch) / 2。
    const computeWatermarkCircle = (imgW, imgH, cw, ch) => ({
        cx: imgW - cw / 2,
        cy: imgH - ch / 2,
        r:  Math.min(cw, ch) / 2
    });

    // 自动检测右下角星标水印的圆形包围（白色/浅色 logo），失败返回 null
    // 思路：
    //   1. 在 [imgW-cwMax, imgW] × [imgH-chMax, imgH] 的 ROI 内采样像素
    //   2. 选高亮度（Y > threshold）且低饱和度（R≈G≈B）的像素作为 logo 候选
    //   3. 用候选点的坐标求中位数（稳健）得到圆心
    //   4. 用候选点到圆心的距离的 95 分位作为半径
    //   5. 数量太少或散布太乱则判定为无水印，返回 null
    function autoDetectWatermark(canvas, ctx, cwMax, chMax) {
        const imgW = canvas.width, imgH = canvas.height;
        const roiX = Math.max(0, imgW - cwMax);
        const roiY = Math.max(0, imgH - chMax);
        const roiW = imgW - roiX;
        const roiH = imgH - roiY;
        if (roiW < 8 || roiH < 8) return null;
        const data = ctx.getImageData(roiX, roiY, roiW, roiH).data;
        const xs = [], ys = [];
        // 亮度阈值：Gemini 星标为亮白色，Y ≈ 230+；容差给到 210 扩大召回
        const LUMA_THRESHOLD = 210;
        const CHROMA_TOLERANCE = 30; // 彩色像素（max-min）应 < 30 才算"近灰色"
        for (let y = 0; y < roiH; y++) {
            for (let x = 0; x < roiW; x++) {
                const p = (y * roiW + x) * 4;
                const r = data[p], g = data[p + 1], b = data[p + 2];
                const luma = 0.299 * r + 0.587 * g + 0.114 * b;
                if (luma < LUMA_THRESHOLD) continue;
                const chroma = Math.max(r, g, b) - Math.min(r, g, b);
                if (chroma > CHROMA_TOLERANCE) continue;
                xs.push(roiX + x);
                ys.push(roiY + y);
            }
        }
        // 样本数太少，无法判定为水印
        if (xs.length < 50) return null;
        // 样本数过多（几乎整块都亮），疑似天空/背景误判，放弃
        if (xs.length > roiW * roiH * 0.6) return null;
        // 中位数圆心
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);
        const cx = xs[Math.floor(xs.length / 2)];
        const cy = ys[Math.floor(ys.length / 2)];
        // 95 分位距离作半径，避免单个孤立亮点把圆扯大
        const dists = [];
        for (let i = 0; i < xs.length; i++) {
            const dx = xs[i] - cx, dy = ys[i] - cy;
            dists.push(Math.sqrt(dx * dx + dy * dy));
        }
        dists.sort((a, b) => a - b);
        const r = dists[Math.floor(dists.length * 0.95)] + 2; // +2 补一点边缘
        // 合理性校验：半径不应大于 ROI 的一半
        if (r * 2 > Math.min(roiW, roiH)) return null;
        return { cx, cy, r, samples: xs.length };
    }
    const getFileName = (w, h) => {
        downloadCount++;
        return `Gemini_Image_${downloadCount.toString().padStart(3, '0')}_${w}x${h}_${Date.now()}.png`;
    };
    function safeSend(msg) {
        return new Promise((res, rej) => {
            if (!chrome.runtime?.id) { rej(new Error("ctx")); return; }
            chrome.runtime.sendMessage(msg, r => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r));
        });
    }
    // 在 content script 内直接拉取图片：origin 为 https://gemini.google.com，能通过 Google CDN 的 CORS。
    // 走 background 的 MV3 service worker 会以 chrome-extension:// 为 origin，CDN 拒绝。
    async function fetchImageAsDataUrl(url) {
        // blob URL 不能 URL 操作；直接 fetch
        let fetchUrl;
        if (url.startsWith('blob:')) {
            fetchUrl = url;
        } else {
            const u = new URL(url);
            u.searchParams.set('_cb', Date.now());
            fetchUrl = u.toString();
        }
        const resp = await fetch(fetchUrl, { method: 'GET', mode: 'cors', cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        return await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onloadend = () => res(reader.result);
            reader.onerror = () => rej(new Error('Failed to read blob'));
            reader.readAsDataURL(blob);
        });
    }
    function removeAllWrappers() {
        document.querySelectorAll('.gemini-dl-wrapper').forEach(w => w.remove());
        document.querySelectorAll('.gemini-dl-miniball').forEach(b => b.remove());
    }
    function getOrCreateContainer() {
        let c = document.getElementById('gemini-dl-root');
        // SPA 路由切换会清空 body，旧 root 变孤儿；失联就重建
        if (c && !c.isConnected) c = null;
        if (!c) {
            c = document.createElement('div'); c.id = 'gemini-dl-root';
            c.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:15px;max-height:80vh;overflow-y:auto;pointer-events:none;';
            // document_start 时 body 可能尚未解析，回退到 documentElement 保持健壮
            (document.body || document.documentElement).appendChild(c);
        }
        return c;
    }
    let globalMiniBall = null;
    let isDragging = false;
    let startX, startY, initLeft, initTop;
    function getOrCreateMiniBall() {
        // SPA 路由切换会清空 body，旧节点变孤儿；需重建
        if (globalMiniBall && globalMiniBall.isConnected) return globalMiniBall;
        globalMiniBall = document.createElement('div');
        globalMiniBall.className = 'gemini-dl-miniball';
        globalMiniBall.setAttribute('role', 'button');
        globalMiniBall.setAttribute('tabindex', '0');
        globalMiniBall.setAttribute('aria-label', '展开 Gemini 助手工作台');
        const iconUrl = chrome.runtime.getURL('icons/icon48.png');
        globalMiniBall.innerHTML = `<img src="${iconUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;pointer-events:none;"/><div style="position:absolute;top:0px;right:0px;width:12px;height:12px;background:#e57373;border-radius:50%;border:2px solid #fff;"></div>`;
        globalMiniBall.title = '展开 Gemini 助手工作台';
        globalMiniBall.style.cssText = 'position:fixed;width:48px;height:48px;border-radius:50%;display:none;align-items:center;justify-content:center;cursor:grab;box-shadow:0 4px 12px rgba(0,0,0,0.5);user-select:none;z-index:999999;transition:transform 0.2s;';
        const setDock = () => {
            const rect = globalMiniBall.getBoundingClientRect();
            const screenW = window.innerWidth;
            globalMiniBall.style.transition = 'left 0.3s, top 0.3s';
            if (rect.left + rect.width / 2 > screenW / 2) {
                globalMiniBall.style.left = `${screenW - rect.width - 20}px`;
            } else {
                globalMiniBall.style.left = '20px';
            }
        };
        const onMouseMove = (e) => {
            if (!isDragging && (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3)) {
                isDragging = true;
                globalMiniBall.style.transition = 'none';
            }
            if (isDragging) {
                globalMiniBall.style.left = `${initLeft + (e.clientX - startX)}px`;
                globalMiniBall.style.top = `${initTop + (e.clientY - startY)}px`;
                globalMiniBall.style.right = 'auto';
                globalMiniBall.style.bottom = 'auto';
            }
        };
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            if (isDragging) setDock();
        };
        globalMiniBall.onmousedown = (e) => {
            startX = e.clientX; startY = e.clientY;
            const rect = globalMiniBall.getBoundingClientRect();
            initLeft = rect.left; initTop = rect.top;
            isDragging = false;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };
        globalMiniBall.onclick = () => {
            if (isDragging) return;
            // 用 getOrCreateContainer 保证 root 一定存在（SPA 切路由后 root 会失联）
            const root = getOrCreateContainer();
            root.style.display = 'flex';
            setTimeout(() => root.scrollTop = root.scrollHeight, 50);
            globalMiniBall.style.display = 'none';
        };
        // 键盘可达：Enter / Space 等价于 click，便于无鼠标场景恢复面板
        globalMiniBall.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                globalMiniBall.click();
            }
        });
        (document.body || document.documentElement).appendChild(globalMiniBall);
        return globalMiniBall;
    }
    async function showDownloadPrompt(previewUrl, downloadUrl, filename) {
        const container = getOrCreateContainer();
        const defs = await new Promise(r => chrome.storage.sync.get({ savedRatio: 'none', savedAnchor: 'center', savedMode: 'penetrate', savedScale: '2' }, r));
        const wrapper = document.createElement('div');
        wrapper.className = 'gemini-dl-wrapper';
        wrapper.style.cssText = 'pointer-events:auto;transition:all 0.3s cubic-bezier(0.25,0.8,0.25,1); transform-origin: bottom right;';
        const card = document.createElement('div');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-label', 'Gemini助手工作台');
        card.style.cssText = 'background:#1e1e1e;color:#e3e3e3;border:1px solid #444;border-radius:12px;padding:12px;width:340px;box-shadow:0 8px 32px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:10px;font-family:"Google Sans",sans-serif;animation:gFadeIn .3s ease-out; transition: opacity 0.3s, transform 0.3s;';
        const toggleMinimize = (e) => {
            if (e) e.stopPropagation();
            const root = getOrCreateContainer();
            root.style.display = 'none';
            const ball = getOrCreateMiniBall();
            // 直接把球放在屏幕右下角，不依赖 root 的 rect（root 可能是空容器导致 rect 为 0）
            ball.style.transition = 'none';
            ball.style.left = 'auto';
            ball.style.top = 'auto';
            ball.style.right = '20px';
            ball.style.bottom = '20px';
            ball.style.display = 'flex';
        };
        if (!document.getElementById('gemini-dl-css')) {
            const s = document.createElement('style'); s.id = 'gemini-dl-css';
            s.textContent = '@keyframes gFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}';
            document.head.appendChild(s);
        }
        let selMode = defs.savedMode, selRatio = defs.savedRatio, selAnchor = defs.savedAnchor, selScale = defs.savedScale;
        const hl = (row, val, clr) => Array.from(row.children).forEach(c => {
            if (c.dataset?.val === val) { c.style.background = clr; c.style.color = '#fff'; }
            else if (c.dataset) { c.style.background = '#3c4043'; c.style.color = '#aaa'; }
        });
        const mkRow = (items, pick) => {
            const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;';
            items.forEach(m => {
                const c = document.createElement('span'); c.textContent = m.label; c.dataset.val = m.val;
                c.style.cssText = 'padding:4px 9px;border-radius:4px;cursor:pointer;font-size:12px;transition:.2s;flex:1;text-align:center;';
                c.onclick = () => pick(m.val, row); row.appendChild(c);
            }); return row;
        };
        const lbl = t => { const d = document.createElement('div'); d.textContent = t; d.style.cssText = 'font-size:11px;color:#9aa0a6;margin-top:3px;'; return d; };
        const g = document.createElement('div'); g.style.cssText = 'display:flex;flex-direction:column;gap:7px;background:#292a2d;padding:8px;border-radius:8px;';
        const aiLabel = document.createElement('span');
        aiLabel.textContent = '🤖 AI修复 …';
        aiLabel.dataset.val = 'ai';
        aiLabel.style.cssText = 'padding:4px 9px;border-radius:4px;cursor:pointer;font-size:12px;transition:.2s;flex:1;text-align:center;background:#3c4043;color:#aaa;';
        checkIOPaintStatus().then(online => {
            const dot = online ? '🟢' : '🔴';
            const tip = online ? 'AI修复 CPU就绪' : 'AI修复 服务离线';
            aiLabel.textContent = `🤖 ${dot} ${tip}`;
            if (!online) {
                aiLabel.title = '请先运行 start_iopaint.bat 启动本地服务';
                aiLabel.style.opacity = '0.55';
                aiLabel.style.cursor = 'not-allowed';
            }
        });
        const mRow = mkRow([{ label: '🖼️ 原图(水印保存)', val: 'penetrate' }, { label: '✂️ 安全裁切', val: 'crop' }], (v, r) => { selMode = v; hl(r, v, '#9c27b0'); });
        mRow.appendChild(aiLabel);
        aiLabel.onclick = () => {
            selMode = 'ai';
            Array.from(mRow.children).forEach(c => {
                const isAi = c === aiLabel;
                c.style.background = isAi ? '#9c27b0' : '#3c4043';
                c.style.color = isAi ? '#fff' : '#aaa';
            });
        };
        // 反向 Alpha 模式：只有当 chrome.storage.local 里存在已校准模板才可用
        const raLabel = document.createElement('span');
        raLabel.dataset.val = 'reverseAlpha';
        raLabel.textContent = '🎯 反向 Alpha …';
        raLabel.style.cssText = 'padding:4px 9px;border-radius:4px;cursor:pointer;font-size:12px;transition:.2s;flex:1;text-align:center;background:#3c4043;color:#aaa;';
        chrome.storage.local.get('reverseAlphaTemplate', res => {
            const ready = !!res.reverseAlphaTemplate;
            raLabel.textContent = ready ? '🎯 反向 Alpha (代数级)' : '🎯 反向 Alpha (未校准)';
            if (!ready) {
                raLabel.title = '请先打开扩展设置页，上传一张 Gemini 生成的纯色背景带水印图进行校准';
                raLabel.style.opacity = '0.55';
                raLabel.style.cursor = 'not-allowed';
            }
            raLabel.onclick = () => {
                if (!ready) return;
                selMode = 'reverseAlpha';
                Array.from(mRow.children).forEach(c => {
                    const isMe = c === raLabel;
                    c.style.background = isMe ? '#9c27b0' : '#3c4043';
                    c.style.color = isMe ? '#fff' : '#aaa';
                });
            };
        });
        mRow.appendChild(raLabel);
        const rRow = mkRow([{ label: '原图', val: 'none' }, { label: '1:1', val: '1' }, { label: '3:4', val: '0.75' }, { label: '4:3', val: '1.33' }, { label: '16:9', val: '1.7777' }], (v, r) => { selRatio = v; hl(r, v, '#1a73e8'); });
        const scaleRow = mkRow([{ label: '1x 标清', val: '1' }, { label: '2x 高清', val: '2' }, { label: '4x 超清', val: '4' }], (v, r) => { selScale = v; hl(r, v, '#e91e63'); });
        const aRow = mkRow([{ label: '中心', val: 'center' }, { label: '顶', val: 'top' }, { label: '底', val: 'bottom' }, { label: '左', val: 'left' }, { label: '右', val: 'right' }], (v, r) => { selAnchor = v; hl(r, v, '#34a853'); });
        const bs = document.createElement('span'); bs.textContent = '💾 设为默认';
        bs.style.cssText = 'margin-left:auto;cursor:pointer;font-size:11px;color:#8ab4f8;padding:3px;';
        bs.onclick = e => { e.stopPropagation(); chrome.storage.sync.set({ savedRatio: selRatio, savedAnchor: selAnchor, savedMode: selMode, savedScale: selScale }, () => { bs.textContent = '✅'; setTimeout(() => bs.textContent = '💾 设为默认', 1500); }); };
        aRow.appendChild(bs);
        hl(mRow, selMode, '#9c27b0'); hl(scaleRow, selScale, '#e91e63'); hl(rRow, selRatio, '#1a73e8'); hl(aRow, selAnchor, '#34a853');
        [lbl('处理引擎'), mRow, lbl('导出画质'), scaleRow, lbl('目标比例'), rRow, lbl('构图锚点'), aRow].forEach(n => g.appendChild(n));
        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
        const title = document.createElement('div'); title.textContent = 'Gemini助手工作台';
        title.style.cssText = 'font-size:14px;font-weight:bold;color:#8ab4f8;';
        const btnMin = document.createElement('button');
        btnMin.textContent = '一键挂起';
        btnMin.title = '最小化为悬浮球，不遮挡屏幕';
        btnMin.style.cssText = 'background:transparent;border:1px solid #444;color:#aaa;padding:2px 8px;border-radius:12px;cursor:pointer;font-size:11px;transition:0.2s;';
        btnMin.onmouseover = () => { btnMin.style.color = '#fff'; btnMin.style.borderColor = '#8ab4f8'; };
        btnMin.onmouseout = () => { btnMin.style.color = '#aaa'; btnMin.style.borderColor = '#444'; };
        btnMin.onclick = toggleMinimize;
        headerRow.appendChild(title);
        headerRow.appendChild(btnMin);
        const imgEl = document.createElement('img'); imgEl.src = previewUrl;
        imgEl.style.cssText = 'width:100%;height:auto;max-height:175px;object-fit:contain;border-radius:6px;background:#000;border:1px solid #333;';
        const btnGrp = document.createElement('div'); btnGrp.style.cssText = 'display:flex;gap:10px;align-items:center;';
        const btnCol = document.createElement('div'); btnCol.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
        const btnX = document.createElement('button'); btnX.textContent = '关闭';
        btnX.style.cssText = 'padding:4px 16px;border:none;background:transparent;color:#aaa;cursor:pointer;font-size:12px;';
        btnX.onclick = () => { wrapper.remove(); };
        const btnXAll = document.createElement('button'); btnXAll.textContent = '全部关闭';
        btnXAll.style.cssText = 'padding:4px 16px;border:none;background:transparent;color:#e57373;cursor:pointer;font-size:12px;';
        btnXAll.onclick = removeAllWrappers;
        btnCol.appendChild(btnX); btnCol.appendChild(btnXAll);
        const btnOK = document.createElement('button'); btnOK.textContent = '执行处理并下载';
        btnOK.style.cssText = 'padding:10px 16px;border:none;background:#8ab4f8;color:#202124;border-radius:18px;cursor:pointer;font-size:13px;font-weight:bold;flex:1;';
        btnOK.onclick = async () => {
            const orig = btnOK.textContent;
            if (selMode === 'ai') {
                const alive = await checkIOPaintStatus();
                if (!alive) {
                    btnOK.textContent = '❌ 服务离线，请先启动 start_iopaint.bat';
                    btnOK.style.background = '#d93025';
                    setTimeout(() => { btnOK.textContent = orig; btnOK.disabled = false; btnOK.style.background = '#8ab4f8'; }, 3000);
                    return;
                }
                btnOK.textContent = '🤖 AI推理中...'; btnOK.disabled = true;
            } else {
                btnOK.textContent = '正在重构...'; btnOK.disabled = true;
            }
            try {
                const dataUrl = await fetchImageAsDataUrl(downloadUrl);
                const img = new Image(); img.src = dataUrl;
                await new Promise(r => img.onload = r);
                const s = await new Promise(r => chrome.storage.sync.get({ cutRight: 83, cutBottom: 83 }, r));
                const gScale = parseFloat(selScale) || 1;
                const imgW = Math.round(img.naturalWidth * gScale), imgH = Math.round(img.naturalHeight * gScale);
                const cw = Math.round(s.cutRight * gScale), ch = Math.round(s.cutBottom * gScale);
                const bc = document.createElement('canvas'); bc.width = imgW; bc.height = imgH;
                const bCtx = bc.getContext('2d', { willReadFrequently: true });
                bCtx.imageSmoothingEnabled = true;
                bCtx.imageSmoothingQuality = 'high';
                bCtx.drawImage(img, 0, 0, imgW, imgH);

                if (gScale > 1) {
                    btnOK.textContent = '🖼️ 纹理细节重塑中...';
                    await new Promise(r => setTimeout(r, 40));
                    const idata = bCtx.getImageData(0, 0, imgW, imgH);
                    // 尝试走 Worker；失败回退主线程（旧内核或 CSP 阻断）
                    const sharpened = (await sharpenInWorker(idata, gScale)) || sharpenInline(idata, gScale);
                    bCtx.putImageData(sharpened, 0, 0);
                }

                let safeW = imgW, safeH = imgH;
                if (selMode === 'crop') {
                    safeW = imgW - cw; safeH = imgH - ch;
                } else if (selMode === 'reverseAlpha') {
                    btnOK.textContent = '🎯 反向 Alpha 中...';
                    safeW = imgW; safeH = imgH;
                    const raTpl = await new Promise(r => chrome.storage.local.get('reverseAlphaTemplate', x => r(x.reverseAlphaTemplate)));
                    if (!raTpl) throw new Error('未找到反向 Alpha 模板，请先校准');
                    if (!window.GeminiReverseAlpha) throw new Error('reverseAlpha.js 未加载');
                    // 反向 Alpha 要求图像尺寸与校准图一致；如果用户选了 2x/4x 放大，先回退到 1x 处理
                    if (gScale !== 1) {
                        dlog('reverseAlpha: gScale != 1, redrawing canvas at native size');
                        bc.width = img.naturalWidth;
                        bc.height = img.naturalHeight;
                        bCtx.imageSmoothingEnabled = true;
                        bCtx.imageSmoothingQuality = 'high';
                        bCtx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight);
                        safeW = bc.width; safeH = bc.height;
                    }
                    if (bc.width !== raTpl.imgW || bc.height !== raTpl.imgH) {
                        throw new Error(`图像尺寸 ${bc.width}×${bc.height} 与校准图 ${raTpl.imgW}×${raTpl.imgH} 不一致。请用同分辨率的图重新校准，或切换其他模式。`);
                    }
                    try {
                        const t0 = performance.now();
                        const r = window.GeminiReverseAlpha.applyTemplate(bc, bCtx, raTpl);
                        dlog(`reverse-alpha applied: ${r.applied} px in ${(performance.now() - t0).toFixed(0)}ms, offset=${r.offset.dx},${r.offset.dy}`);
                    } catch (e) {
                        throw new Error('反向 Alpha 失败: ' + e.message);
                    }
                } else if (selMode === 'ai') {
                    btnOK.textContent = '🤖 AI推理准备中...';
                    safeW = imgW; safeH = imgH;
                    // 优先自动定位：在 (cw, ch) 配置范围内寻找星标；失败回退到手动配置
                    const auto = autoDetectWatermark(bc, bCtx, cw, ch);
                    let cx, cy, R;
                    if (auto) {
                        cx = auto.cx; cy = auto.cy; R = auto.r;
                        dlog('auto-detected watermark:', auto.cx, auto.cy, 'r=', auto.r, 'samples=', auto.samples);
                    } else {
                        const fallback = computeWatermarkCircle(imgW, imgH, cw, ch);
                        cx = fallback.cx; cy = fallback.cy; R = fallback.r;
                        dlog('auto-detect failed, using manual circle', cx, cy, 'r=', R);
                    }
                    const padding = Math.round(64 * gScale);
                    const patchX = Math.max(0, Math.floor(cx - R - padding));
                    const patchY = Math.max(0, Math.floor(cy - R - padding));
                    const patchW = imgW - patchX;
                    const patchH = imgH - patchY;
                    const upScale = gScale < 2 ? 2 : 1;
                    const upW = patchW * upScale;
                    const upH = patchH * upScale;
                    const patchCanvas = document.createElement('canvas');
                    patchCanvas.width = upW; patchCanvas.height = upH;
                    const pCtx = patchCanvas.getContext('2d', { alpha: false });
                    pCtx.imageSmoothingEnabled = true;
                    pCtx.imageSmoothingQuality = 'high';
                    pCtx.drawImage(bc, patchX, patchY, patchW, patchH, 0, 0, upW, upH);
                    const upCX = (cx - patchX) * upScale;
                    const upCY = (cy - patchY) * upScale;
                    const upR = R * upScale;
                    const maskCanvas = document.createElement('canvas');
                    maskCanvas.width = upW; maskCanvas.height = upH;
                    const mCtx = maskCanvas.getContext('2d', { alpha: false });
                    mCtx.fillStyle = '#000';
                    mCtx.fillRect(0, 0, upW, upH);
                    mCtx.fillStyle = '#fff';
                    mCtx.beginPath();
                    // 小羽化：半径多 1.5 个上采样像素，避免硬边锯齿
                    mCtx.arc(upCX, upCY, upR + (1.5 * upScale), 0, Math.PI * 2);
                    mCtx.fill();
                    const imageB64 = patchCanvas.toDataURL('image/png').split(',')[1];
                    const maskB64 = maskCanvas.toDataURL('image/png').split(',')[1];
                    let aiResp;
                    try {
                        btnOK.textContent = '🤖 LaMa 高清纹理重塑中...';
                        const fetchResp = await fetch(`${IOPAINT_URL}/api/v1/inpaint`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                image: imageB64,
                                mask: maskB64
                            }),
                            signal: AbortSignal.timeout(30000)
                        });
                        if (!fetchResp.ok) {
                            const errText = await fetchResp.text();
                            throw new Error(`API 返回错误 ${fetchResp.status}: ${errText}`);
                        }
                        aiResp = await fetchResp.json();
                    } catch (fetchErr) {
                        throw new Error(`服务请求失败：${fetchErr.message}`);
                    }
                    const resultImg = new Image();
                    resultImg.src = 'data:image/png;base64,' + aiResp.image;
                    await new Promise((res, rej) => {
                        resultImg.onload = res;
                        resultImg.onerror = () => rej(new Error('还原图片解码失败'));
                    });
                    bCtx.imageSmoothingEnabled = true;
                    bCtx.imageSmoothingQuality = 'high';
                    bCtx.drawImage(resultImg, 0, 0, upW, upH, patchX, patchY, patchW, patchH);
                } else if (selMode === 'penetrate') {
                    safeW = imgW; safeH = imgH;
                }
                let sX = 0, sY = 0, fW = safeW, fH = safeH;
                if (selRatio !== 'none') {
                    const tR = parseFloat(selRatio);
                    if (selAnchor === 'center') {
                        if (safeW / safeH > tR) { fH = safeH; fW = fH * tR; } else { fW = safeW; fH = fW / tR; }
                        sX = safeW / 2 - fW / 2; sY = safeH / 2 - fH / 2;
                    } else {
                        if (safeW / safeH > tR) {
                            fH = safeH; fW = safeH * tR;
                            if (selAnchor === 'right') sX = safeW - fW; else if (selAnchor === 'left') sX = 0; else sX = (safeW - fW) / 2;
                        } else {
                            fW = safeW; fH = safeW / tR;
                            if (selAnchor === 'bottom') sY = safeH - fH; else if (selAnchor === 'top') sY = 0; else sY = (safeH - fH) / 2;
                        }
                    }
                }
                const fc = document.createElement('canvas'); fc.width = Math.round(fW); fc.height = Math.round(fH);
                fc.getContext('2d').drawImage(bc, sX, sY, fW, fH, 0, 0, fW, fH);
                const prefixMap = { penetrate: 'Penetrated_', crop: 'Cropped_', ai: 'AI_Repaired_', reverseAlpha: 'AlphaReversed_' };
                const prefix = prefixMap[selMode] || 'Processed_';
                fc.toBlob(async blob => {
                    const ou = URL.createObjectURL(blob);
                    await safeSend({ action: 'download', url: ou, filename: prefix + filename });
                    btnOK.textContent = '✅ 已输出'; btnOK.style.background = '#34a853';
                    setTimeout(() => {
                        btnOK.textContent = orig;
                        btnOK.disabled = false;
                        btnOK.style.background = '#8ab4f8';
                        URL.revokeObjectURL(ou);
                    }, 2000);
                }, 'image/png');
            } catch (e) {
                console.error(e);
                btnOK.textContent = '引擎异常'; btnOK.style.background = '#d93025';
                setTimeout(() => { btnOK.textContent = orig; btnOK.disabled = false; btnOK.style.background = '#8ab4f8'; }, 2000);
            }
        };
        btnGrp.appendChild(btnCol); btnGrp.appendChild(btnOK);
        [headerRow, imgEl, g, btnGrp].forEach(n => card.appendChild(n));
        wrapper.appendChild(card);
        container.appendChild(wrapper);
    }
    async function processImage(url, node) {
        // scheme 检查：允许 blob: / http: / https:
        if (!isAllowedScheme(url)) { dlog('skip: bad scheme', url.slice(0, 40)); return; }
        // 节点级去重：同一个 <img> 元素只处理一次，即使 src 被 Gemini 反复重赋值
        if (node && processedNodes.has(node)) { dlog('skip: node processed'); return; }
        // 白名单容器：必须在 Gemini 对话消息容器内（如 <message-content>）
        if (!node || !isInAllowedContainer(node)) {
            dlog('skip: not in allowed container', node?.parentElement?.tagName);
            return;
        }
        // 黑名单容器：双重保险，排除容器内的头像/账号按钮
        if (isInExcludedContainer(node)) { dlog('skip: in excluded container'); return; }
        // 去重 key：blob URL 每次不同，按节点去重已足够；非 blob 仍用 cleanUrl
        const cl = url.startsWith('blob:') ? url : cleanUrl(url);
        if (uploadedSet.has(cl) || processingSet.has(cl)) { dlog('skip: already uploaded/processing'); return; }
        processingSet.add(cl);
        dlog('accepted, probing size:', (node.naturalWidth || '?') + 'x' + (node.naturalHeight || '?'), url.slice(-40));
        try {
            let w = node.naturalWidth || 0;
            let h = node.naturalHeight || 0;
            // 节点尺寸为 0 说明还没解码完；等一下再读
            if (!w || !h) {
                try {
                    await new Promise((res, rej) => {
                        const onLoad = () => { w = node.naturalWidth; h = node.naturalHeight; cleanup(); res(); };
                        const onErr  = () => { cleanup(); rej(new Error('img load failed')); };
                        const timer  = setTimeout(() => { cleanup(); rej(new Error('timeout')); }, 5000);
                        const cleanup = () => {
                            node.removeEventListener('load', onLoad);
                            node.removeEventListener('error', onErr);
                            clearTimeout(timer);
                        };
                        if (node.complete && node.naturalWidth) { onLoad(); return; }
                        node.addEventListener('load', onLoad);
                        node.addEventListener('error', onErr);
                    });
                } catch { /* 探测失败按未知尺寸处理 */ }
            }
            if (w && w < CONFIG.MIN_SIZE) {
                dlog('skip: too small', w, 'x', h, url.slice(-40));
                uploadedSet.add(cl); processingSet.delete(cl); return;
            }
            uploadedSet.add(cl); processingSet.delete(cl);
            if (node) processedNodes.add(node);
            dlog('✓ opening panel for', w, 'x', h, url.slice(-60));
            // blob URL 直接用原图；普通 URL 走 =s4096 拿高分辨率
            const downloadUrl = url.startsWith('blob:') ? url : buildHiResUrl(cl);
            await showDownloadPrompt(url, downloadUrl, getFileName(w, h));
        } catch { processingSet.delete(cl); }
    }

    // 节点级去重集合：即使同一张图的 URL 因重定向/token 变化被 Gemini React 多次重新挂载，
    // 同一个 <img> DOM 节点只会被处理一次。WeakSet 避免内存泄漏（节点被 GC 时自动清理）。
    const processedNodes = new WeakSet();

    // MutationObserver 批处理：Gemini 聊天流 DOM 变化频繁，累积后在空闲帧统一处理，降低主线程抖动。
    const pendingImages = new Map();  // node -> src
    const scheduleFlush = (() => {
        let scheduled = false;
        const schedule = window.requestIdleCallback
            ? (cb) => window.requestIdleCallback(cb, { timeout: 500 })
            : (cb) => setTimeout(cb, 100);
        return () => {
            if (scheduled) return;
            scheduled = true;
            schedule(() => {
                scheduled = false;
                const entries = Array.from(pendingImages.entries());
                pendingImages.clear();
                entries.forEach(([node, src]) => processImage(src, node));
            });
        };
    })();
    const queueImg = (node) => {
        if (!node || processedNodes.has(node)) return;
        const src = node.currentSrc || node.src;
        // Gemini 生成图是 blob: 开头，其他图才是 http(s):
        if (src && (src.startsWith('http') || src.startsWith('blob:'))) {
            dlog('queued img:', (node.naturalWidth || '?') + 'x' + (node.naturalHeight || '?'), src.slice(-60));
            pendingImages.set(node, src);
            scheduleFlush();
        } else {
            dlog('img has no usable src yet:', (src || '(empty)').slice(0, 40));
        }
    };

    dlog('content.js v2 loaded at', new Date().toISOString().slice(11, 19));

    // 主 Observer：节点新增 + 属性变化（Gemini 异步填 src，必须监听 attributes）
    new MutationObserver(muts => {
        for (const m of muts) {
            if (m.type === 'attributes') {
                // src 被赋值时再次入队这个节点
                if (m.target.tagName === 'IMG') queueImg(m.target);
                continue;
            }
            m.addedNodes.forEach(n => {
                if (n.nodeType !== 1) return;
                if (n.tagName === 'IMG') queueImg(n);
                else n.querySelectorAll?.('img').forEach(queueImg);
            });
        }
    }).observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
    });

    // document_start 时 body 里可能已有预渲染图片，补扫一次
    const initialImgs = (document.body || document.documentElement).querySelectorAll?.('img') || [];
    dlog('initial scan: found', initialImgs.length, 'img elements');
    initialImgs.forEach(queueImg);
})();