// 设置页逻辑：读取/写入水印圆形定位参数
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
