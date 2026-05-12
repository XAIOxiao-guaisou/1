// popup 逻辑：探测 AI 后端状态 + 提供快捷入口。
const IOPAINT_URL = 'http://127.0.0.1:8080';
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const tip = document.getElementById('tip');

async function probe() {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(`${IOPAINT_URL}/api/v1/model`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const info = await r.json();
        if (info.ready) {
            dot.className = 'dot on';
            statusText.textContent = `AI 就绪（设备: ${info.device || 'cpu'}）`;
            tip.textContent = '后端运行正常，可在 Gemini 中直接使用 AI 修复模式。';
        } else {
            dot.className = 'dot off';
            statusText.textContent = '模型加载中，稍候...';
            tip.textContent = '后端已启动但模型未就绪，首次可能需要几十秒加载。';
        }
    } catch {
        dot.className = 'dot off';
        statusText.textContent = 'AI 后端离线';
        tip.textContent = '请运行 2_Python_AI_Backend/启动AI服务.bat 启动本地服务（不启动仍可使用 原图/裁切 两种模式）。';
    }
}

document.getElementById('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
});

document.getElementById('openGemini').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://gemini.google.com/' });
});

probe();
