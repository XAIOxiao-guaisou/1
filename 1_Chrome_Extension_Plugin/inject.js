(function () {
    const originalFetch = window.fetch;
    const WHITELIST_HOSTS = [
        'gemini.google.com',
        'googleusercontent.com'
    ];
    const NOISE_HOSTS = [
        'googleadservices.com',
        'googletagmanager.com',
        'doubleverify.com',
        'adnxs.com',
        'quantserve.com',
        'analytics.google.com'
    ];

    // 仅用于判定是否需要拦截分析；出错或不匹配时返回 null，调用方走原生 fetch。
    function resolveTargetUrl(input) {
        try {
            const raw = (input instanceof Request) ? input.url : String(input);
            const urlObj = new URL(raw, window.location.origin);
            const host = urlObj.hostname;
            if (NOISE_HOSTS.some(h => host.includes(h))) return null;
            const matched = WHITELIST_HOSTS.some(h => host === h || host.endsWith('.' + h));
            return matched ? raw : null;
        } catch {
            return null;
        }
    }

    window.fetch = function (...args) {
        const targetUrl = resolveTargetUrl(args[0]);
        const result = originalFetch.apply(this, args);
        if (!targetUrl) return result;
        // 不改原返回值：只在 resolve 成功且 Content-Type 命中图片时广播事件。
        return result.then(res => {
            try {
                if (res.ok && res.headers.get('content-type')?.includes('image/')) {
                    document.dispatchEvent(new CustomEvent('GeminiImageInterceptor', {
                        detail: { url: targetUrl }
                    }));
                }
            } catch { /* 非阻塞：任何探测错误都不影响原请求 */ }
            return res;
        });
    };
})();
