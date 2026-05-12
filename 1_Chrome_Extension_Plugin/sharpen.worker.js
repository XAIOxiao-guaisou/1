// 锐化 Worker：与主线程算法一致的五点 unsharp mask，脱离主线程避免页面卡顿。
// 入参: { buffer: ArrayBuffer, width, height, gScale }（buffer 所有权转移）
// 出参: { buffer: ArrayBuffer }（同样以 transferable 形式回传）

self.onmessage = (e) => {
    const { buffer, width, height, gScale } = e.data;
    if (!buffer) {
        self.postMessage({ error: 'missing buffer' });
        return;
    }

    const d   = new Uint8ClampedArray(buffer);
    const src = new Uint8ClampedArray(d);          // 采样副本，避免就地写入污染邻居
    const w4  = width * 4;
    const mix = gScale >= 4 ? 0.8 : 0.6;
    const center = 4 * mix + 1;
    const side   = -mix;

    for (let y = 1; y < height - 1; y++) {
        let p = y * w4 + 4;
        let pUp = p - w4;
        let pDown = p + w4;
        for (let x = 1; x < width - 1; x++) {
            for (let c = 0; c < 3; c++) {
                const v = src[p + c] * center
                        + src[p - 4 + c] * side
                        + src[p + 4 + c] * side
                        + src[pUp + c]   * side
                        + src[pDown + c] * side;
                const diff = v - src[p + c];
                d[p + c] = src[p + c] + diff * 1.1;
            }
            p += 4; pUp += 4; pDown += 4;
        }
    }

    self.postMessage({ buffer: d.buffer }, [d.buffer]);
};
