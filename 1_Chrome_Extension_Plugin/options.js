// 设置页逻辑：水印圆形定位参数 + 反向 Alpha 模板校准
const STORAGE_KEY_TEMPLATE = 'reverseAlphaTemplate';

// ========== 圆形定位参数 ==========
chrome.storage.sync.get({ cutRight: 83, cutBottom: 83 }, s => {
    document.getElementById('cutRight').value = s.cutRight;
    document.getElementById('cutBottom').value = s.cutBottom;
});

document.getElementById('save').addEventListener('click', () => {
    const cutRight = parseInt(document.getElementById('cutRight').value, 10) || 83;
    const cutBottom = parseInt(document.getElementById('cutBottom').value, 10) || 83;
    chrome.storage.sync.set({ cutRight, cutBottom }, () => {
        const btn = document.getElementById('save');
        btn.textContent = '✅ 已保存！';
        setTimeout(() => { btn.textContent = '💾 保存并应用'; }, 1500);
    });
});

// ========== 反向 Alpha 模板校准 ==========
const calibFile = document.getElementById('calibFile');
const calibBtn = document.getElementById('calibrate');
const calibStatus = document.getElementById('calibStatus');
const calibPreview = document.getElementById('calibPreview');
const clearBtn = document.getElementById('clearTemplate');

let calibImage = null;  // 已加载的 Image 对象

calibFile.addEventListener('change', () => {
    const file = calibFile.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
        calibImage = img;
        calibStatus.textContent = `已加载 ${img.naturalWidth}×${img.naturalHeight}，点击下方按钮开始校准。`;
        calibStatus.style.color = '#aecbfa';
    };
    img.onerror = () => {
        calibStatus.textContent = '❌ 图片加载失败';
        calibStatus.style.color = '#e57373';
    };
    img.src = url;
});

calibBtn.addEventListener('click', () => {
    if (!calibImage) {
        calibStatus.textContent = '请先选择校准图';
        calibStatus.style.color = '#e57373';
        return;
    }
    calibBtn.disabled = true;
    calibStatus.textContent = '🔬 校准中...';
    calibStatus.style.color = '#aecbfa';

    // 异步执行避免阻塞 UI
    setTimeout(() => {
        try {
            const tpl = window.GeminiReverseAlpha.calibrateFromImage(calibImage, {
                cwMax: 150, chMax: 150
            });
            // 持久化（chrome.storage.sync 单条上限 8KB；alpha 数组可能过大 → 用 local）
            chrome.storage.local.set({ [STORAGE_KEY_TEMPLATE]: tpl }, () => {
                if (chrome.runtime.lastError) {
                    calibStatus.textContent = '❌ 保存失败：' + chrome.runtime.lastError.message;
                    calibStatus.style.color = '#e57373';
                } else {
                    calibStatus.innerHTML = `✅ 校准完成<br>水印盒：${tpl.box.w}×${tpl.box.h}px，距右下 (${tpl.rightOffset}, ${tpl.bottomOffset})<br>水印本色：rgb(${tpl.W_rgb.join(', ')})`;
                    calibStatus.style.color = '#34a853';
                    renderPreview(tpl);
                }
                calibBtn.disabled = false;
            });
        } catch (e) {
            calibStatus.textContent = '❌ ' + e.message;
            calibStatus.style.color = '#e57373';
            calibBtn.disabled = false;
        }
    }, 30);
});

// 校准后预览：把 alpha 通道可视化（白=高 alpha，黑=低 alpha）
function renderPreview(tpl) {
    const cv = calibPreview;
    cv.width = tpl.box.w * 2 + 16;  // 左：alpha 可视化  右：原模板色叠 BG
    cv.height = tpl.box.h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const img1 = ctx.createImageData(tpl.box.w, tpl.box.h);
    const img2 = ctx.createImageData(tpl.box.w, tpl.box.h);
    const alpha = tpl.alpha;
    for (let i = 0; i < tpl.box.w * tpl.box.h; i++) {
        const a = alpha[i];
        const v = Math.round(a * 255);
        img1.data[i * 4] = v; img1.data[i * 4 + 1] = v; img1.data[i * 4 + 2] = v; img1.data[i * 4 + 3] = 255;
        // 右图：在黑底上重建一次 (W_rgb * α)，让用户看到水印本身的样子
        img2.data[i * 4] = Math.round(tpl.W_rgb[0] * a);
        img2.data[i * 4 + 1] = Math.round(tpl.W_rgb[1] * a);
        img2.data[i * 4 + 2] = Math.round(tpl.W_rgb[2] * a);
        img2.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img1, 0, 0);
    ctx.putImageData(img2, tpl.box.w + 16, 0);
    cv.style.display = 'block';
}

clearBtn.addEventListener('click', () => {
    chrome.storage.local.remove(STORAGE_KEY_TEMPLATE, () => {
        calibStatus.textContent = '尚未校准。当前 AI 修复模式仍使用 LaMa 补全。';
        calibStatus.style.color = '#9aa0a6';
        calibPreview.style.display = 'none';
    });
});

// 启动时显示已有模板状态
chrome.storage.local.get(STORAGE_KEY_TEMPLATE, res => {
    const tpl = res[STORAGE_KEY_TEMPLATE];
    if (tpl) {
        calibStatus.innerHTML = `✅ 已存在模板<br>水印盒：${tpl.box.w}×${tpl.box.h}px，距右下 (${tpl.rightOffset}, ${tpl.bottomOffset})<br>水印本色：rgb(${tpl.W_rgb.join(', ')})`;
        calibStatus.style.color = '#34a853';
        renderPreview(tpl);
    }
});
