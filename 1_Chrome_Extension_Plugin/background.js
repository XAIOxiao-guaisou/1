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
    if (request.action === "fetch_blob") {
        const urlObj = new URL(request.url);
        urlObj.searchParams.set("_cb", Date.now());
        fetch(urlObj.toString(), {
            method: 'GET',
            mode: 'cors',
            cache: 'no-store'
        })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.blob();
            })
            .then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ success: true, dataUrl: reader.result });
                reader.onerror = () => sendResponse({ success: false, error: "Failed to read blob" });
                reader.readAsDataURL(blob);
            })
            .catch(error => {
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }
});