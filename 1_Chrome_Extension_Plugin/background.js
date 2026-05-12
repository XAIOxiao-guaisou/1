// MV3 service worker：只处理 downloads API，图片 fetch 在 content script 里直接完成
// （content 页面 origin 能通过 Google CDN 的 CORS；service worker 的 chrome-extension:// origin 会被拒）。
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "download") {
        const filename = request.filename || `Gemini_Downloads/image_${Date.now()}.png`;
        const finalFilename = filename.startsWith('Gemini_Downloads/') ? filename : `Gemini_Downloads/${filename}`;
        chrome.downloads.download({
            url: request.url,
            filename: finalFilename,
            conflictAction: "uniquify",
            saveAs: false
        }, (id) => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError);
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ success: true, id: id });
            }
        });
        return true;
    }
});
