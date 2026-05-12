(function () {
    'use strict';
    const CONFIG = { MIN_SIZE: 200, DOMAINS: ['googleusercontent.com', 'gemini.google.com'] };
    const IOPAINT_URL = 'http://127.0.0.1:8080';
    const SHARPEN_WORKER_URL = chrome.runtime.getURL('sharpen.worker.js');
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
    function removeAllWrappers() {
        document.querySelectorAll('.gemini-dl-wrapper').forEach(w => w.remove());
        document.querySelectorAll('.gemini-dl-miniball').forEach(b => b.remove());
    }
    function getOrCreateContainer() {
        let c = document.getElementById('gemini-dl-root');
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
        if (globalMiniBall) return globalMiniBall;
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
        globalMiniBall.onclick = (e) => {
            if (isDragging) return;
            const root = document.getElementById('gemini-dl-root');
            if (root) {
                root.style.display = 'flex';
                setTimeout(() => root.scrollTop = root.scrollHeight, 50);
            }
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
            const root = document.getElementById('gemini-dl-root');
            if (!root) return;
            const originalRect = root.getBoundingClientRect();
            root.style.display = 'none';
            const ball = getOrCreateMiniBall();
            ball.style.display = 'flex';
            ball.style.transition = 'none';
            ball.style.right = 'auto';
            ball.style.bottom = 'auto';
            ball.style.left = `${originalRect.right - 48}px`;
            ball.style.top = `${originalRect.bottom - 48}px`;
            setTimeout(() => {
                const screenW = window.innerWidth;
                ball.style.transition = 'left 0.3s, top 0.3s';
                if (ball.getBoundingClientRect().left + 24 > screenW / 2) {
                    ball.style.left = `${screenW - 48 - 20}px`;
                } else {
                    ball.style.left = '20px';
                }
            }, 50);
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
                const resp = await safeSend({ action: 'fetch_blob', url: downloadUrl });
                if (!resp?.success) throw new Error('fetch failed');
                const img = new Image(); img.src = resp.dataUrl;
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
                } else if (selMode === 'ai') {
                    btnOK.textContent = '🤖 AI推理准备中...';
                    safeW = imgW; safeH = imgH;
                    // 与 options.html 文档保持一致：水印圆心/半径由 cutRight、cutBottom 唯一决定。
                    const { cx, cy, r: R } = computeWatermarkCircle(imgW, imgH, cw, ch);
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
                const prefixMap = { penetrate: 'Penetrated_', crop: 'Cropped_', ai: 'AI_Repaired_' };
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
    async function processImage(url) {
        if (url.startsWith('blob:') || url.startsWith('data:')) return;
        const cl = cleanUrl(url);
        if (uploadedSet.has(cl) || processingSet.has(cl)) return;
        processingSet.add(cl);
        if (!CONFIG.DOMAINS.some(d => url.includes(d))) { processingSet.delete(cl); return; }
        try {
            let w = 0, h = 0;
            try {
                const img = new Image(); img.src = url;
                await new Promise((res, rej) => {
                    img.onload = () => { w = img.naturalWidth; h = img.naturalHeight; res(); };
                    img.onerror = () => rej();
                    setTimeout(() => rej(), 5000);
                });
                if (w < CONFIG.MIN_SIZE) { uploadedSet.add(cl); processingSet.delete(cl); return; }
            } catch { /* 尺寸探测失败时仍允许继续，按未知尺寸处理 */ }
            uploadedSet.add(cl); processingSet.delete(cl);
            await showDownloadPrompt(url, buildHiResUrl(cl), getFileName(w, h));
        } catch { processingSet.delete(cl); }
    }
    const sc = document.createElement('script'); sc.src = chrome.runtime.getURL('inject.js');
    sc.onload = () => sc.remove();
    (document.head || document.documentElement).appendChild(sc);
    document.addEventListener('GeminiImageInterceptor', e => { if (e.detail?.url) processImage(e.detail.url); });

    // MutationObserver 批处理：Gemini 聊天流 DOM 变化频繁，累积后在空闲帧统一处理，降低主线程抖动。
    const pendingImages = new Set();
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
                const urls = Array.from(pendingImages);
                pendingImages.clear();
                urls.forEach(u => processImage(u));
            });
        };
    })();
    const queueImg = (src) => {
        if (src && src.startsWith('http')) {
            pendingImages.add(src);
            scheduleFlush();
        }
    };

    new MutationObserver(muts => {
        for (const m of muts) m.addedNodes.forEach(n => {
            if (n.nodeType !== 1) return;
            if (n.tagName === 'IMG') queueImg(n.src);
            else n.querySelectorAll?.('img').forEach(i => queueImg(i.src));
        });
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
})();