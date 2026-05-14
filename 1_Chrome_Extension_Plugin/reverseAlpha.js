// 反向 Alpha 混合：纯数学方法擦除 Gemini "Nano Banana" 水印。
//
// 前提：Google 用标准 Alpha 混合把水印叠到原图：
//     output = original * (1 - α) + W_rgb * α
// 反解：
//     original = (output - W_rgb * α) / (1 - α)
//
// 在 Nano Banana 水印是"单色（近白）logo + 渐变 α 通道"的前提下，可以简化：
// - 假设 W_rgb ≈ (W, W, W) 常量（可校准）
// - 用户提供一张已知背景色（最好纯黑/纯色）的校准图 → 反推出 α 映射
// - 之后对任意图应用相同的 α 图，代数级精确恢复原像素
//
// 自适应：如果背景不是纯黑，用图像主色作为 bg reference。
//
// 暴露：
//   window.GeminiReverseAlpha = { calibrateFromImage, applyTemplate }

(function () {
    'use strict';

    /**
     * 从一张校准图（推荐：纯黑背景 + Gemini 水印）提取 α 模板。
     *
     * 算法：
     *   1. 估计背景色 BG：取图像所有像素的中位数 RGB（水印区域小，被中位数拒绝）
     *   2. 找水印区域 ROI：右下角 cwMax × chMax 范围内，亮度明显 > BG 的像素
     *   3. 取 ROI 的紧致包围盒（带 2px 余量）
     *   4. 估计水印颜色 W_rgb：ROI 内亮度前 5% 像素的 RGB 均值（忽略 α 很小的边缘像素）
     *   5. 计算每个 ROI 像素的 α：
     *         假设该像素原本就是 BG：output = BG*(1-α) + W_rgb*α
     *         → α = (output - BG) / (W_rgb - BG)，分通道求均值再裁剪到 [0, 1]
     *
     * @param {HTMLImageElement|HTMLCanvasElement} image 校准源图
     * @param {object} [opts]
     * @param {number} [opts.cwMax=120] 右下角搜索宽度（像素）
     * @param {number} [opts.chMax=120] 右下角搜索高度（像素）
     * @returns {object} template
     *   - imgW, imgH: 校准图总尺寸
     *   - box: { x, y, w, h } 水印包围盒（左上角坐标，相对整图）
     *   - rightOffset: imgW - (box.x + box.w)，水印距右边缘的距离
     *   - bottomOffset: imgH - (box.y + box.h)
     *   - W_rgb: [R, G, B] 水印本色（0-255）
     *   - alpha: Float32Array，长度 = box.w * box.h，按行主序
     */
    function calibrateFromImage(image, opts = {}) {
        const { cwMax = 120, chMax = 120 } = opts;
        const imgW = image.naturalWidth || image.width;
        const imgH = image.naturalHeight || image.height;
        const canvas = document.createElement('canvas');
        canvas.width = imgW; canvas.height = imgH;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);

        // ---- 1. 估计背景色 BG ----
        // 一次取整图数据，稀疏采样按索引读（避免数千次 getImageData 调用）
        const fullData = ctx.getImageData(0, 0, imgW, imgH).data;
        const step = Math.max(1, Math.floor(Math.min(imgW, imgH) / 128));
        const rs = [], gs = [], bs = [];
        for (let y = 0; y < imgH; y += step) {
            for (let x = 0; x < imgW; x += step) {
                const p = (y * imgW + x) * 4;
                rs.push(fullData[p]); gs.push(fullData[p + 1]); bs.push(fullData[p + 2]);
            }
        }
        rs.sort((a, b) => a - b);
        gs.sort((a, b) => a - b);
        bs.sort((a, b) => a - b);
        const mid = rs.length >> 1;
        const BG = [rs[mid], gs[mid], bs[mid]];

        // ---- 2. 找 ROI ----
        const roiX = Math.max(0, imgW - cwMax);
        const roiY = Math.max(0, imgH - chMax);
        const roiW = imgW - roiX;
        const roiH = imgH - roiY;
        const roiData = ctx.getImageData(roiX, roiY, roiW, roiH).data;

        // "明显高于背景"的阈值：按通道取 BG + 30
        const thr = BG.map(v => v + 30);
        let minX = roiW, minY = roiH, maxX = 0, maxY = 0;
        let hits = 0;
        for (let y = 0; y < roiH; y++) {
            for (let x = 0; x < roiW; x++) {
                const p = (y * roiW + x) * 4;
                if (roiData[p] > thr[0] && roiData[p + 1] > thr[1] && roiData[p + 2] > thr[2]) {
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                    hits++;
                }
            }
        }
        if (hits < 20) {
            throw new Error('未检测到明显水印像素，请确认图片右下角确实有水印且背景足够干净');
        }

        // 包围盒加 2px 余量
        minX = Math.max(0, minX - 2);
        minY = Math.max(0, minY - 2);
        maxX = Math.min(roiW - 1, maxX + 2);
        maxY = Math.min(roiH - 1, maxY + 2);
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;

        // ---- 3. 估计水印本色 W_rgb：取 box 内亮度前 5% 像素的均值 ----
        const boxData = ctx.getImageData(roiX + minX, roiY + minY, bw, bh).data;
        const pxLumaList = [];
        for (let y = 0; y < bh; y++) {
            for (let x = 0; x < bw; x++) {
                const p = (y * bw + x) * 4;
                const luma = 0.299 * boxData[p] + 0.587 * boxData[p + 1] + 0.114 * boxData[p + 2];
                pxLumaList.push({ p, luma });
            }
        }
        pxLumaList.sort((a, b) => b.luma - a.luma);
        const top = pxLumaList.slice(0, Math.max(1, Math.floor(pxLumaList.length * 0.05)));
        let sumR = 0, sumG = 0, sumB = 0;
        for (const t of top) { sumR += boxData[t.p]; sumG += boxData[t.p + 1]; sumB += boxData[t.p + 2]; }
        const W_rgb = [
            Math.round(sumR / top.length),
            Math.round(sumG / top.length),
            Math.round(sumB / top.length)
        ];
        // 如果 W_rgb 与 BG 过于接近会让下面除零；保底提一下对比度
        for (let i = 0; i < 3; i++) {
            if (W_rgb[i] - BG[i] < 20) W_rgb[i] = Math.min(255, BG[i] + 20);
        }

        // ---- 4. 计算每像素 alpha ----
        const alpha = new Float32Array(bw * bh);
        for (let y = 0; y < bh; y++) {
            for (let x = 0; x < bw; x++) {
                const p = (y * bw + x) * 4;
                // 分通道求 α，再取均值；对 W_rgb - BG 差距大的通道更可信
                let sumA = 0, weightSum = 0;
                for (let c = 0; c < 3; c++) {
                    const denom = W_rgb[c] - BG[c];
                    if (denom < 5) continue;  // 此通道无判别力
                    const a = (boxData[p + c] - BG[c]) / denom;
                    const w = denom;  // 权重 = 通道对比度
                    sumA += a * w;
                    weightSum += w;
                }
                const a = weightSum > 0 ? Math.max(0, Math.min(1, sumA / weightSum)) : 0;
                alpha[y * bw + x] = a;
            }
        }

        return {
            imgW, imgH,
            box: { x: roiX + minX, y: roiY + minY, w: bw, h: bh },
            rightOffset: imgW - (roiX + minX + bw),
            bottomOffset: imgH - (roiY + minY + bh),
            W_rgb,
            alpha: Array.from(alpha)  // JSON 可序列化
        };
    }

    /**
     * 把模板应用到目标图像，擦除水印。
     *
     * 定位策略：按 rightOffset / bottomOffset 从目标图右下角倒推水印位置，
     * 假定水印尺寸固定、只是图像整体尺寸变化。
     *
     * @param {HTMLCanvasElement} canvas 目标画布（就地修改）
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} template calibrateFromImage 的返回值（alpha 可是 Array 或 Float32Array）
     * @returns {object} { applied, box } applied: 实际擦除的像素数；box: 擦除区域
     */
    function applyTemplate(canvas, ctx, template) {
        const { box, rightOffset, bottomOffset, W_rgb, alpha } = template;
        const alphaArr = alpha instanceof Float32Array ? alpha : Float32Array.from(alpha);
        const imgW = canvas.width, imgH = canvas.height;

        // 目标图上水印的位置：对齐到右下角
        const tx = imgW - rightOffset - box.w;
        const ty = imgH - bottomOffset - box.h;
        if (tx < 0 || ty < 0 || tx + box.w > imgW || ty + box.h > imgH) {
            throw new Error(`目标图太小，无法放下水印模板（目标 ${imgW}x${imgH}, 模板 ${box.w}x${box.h}）`);
        }

        const roi = ctx.getImageData(tx, ty, box.w, box.h);
        const d = roi.data;
        let applied = 0;
        const ALPHA_SAT = 0.98;  // α 接近 1 时原像素信息已完全被覆盖，无法恢复

        for (let y = 0; y < box.h; y++) {
            for (let x = 0; x < box.w; x++) {
                const a = alphaArr[y * box.w + x];
                if (a < 0.02) continue;  // 几乎没有水印，跳过
                const p = (y * box.w + x) * 4;
                if (a >= ALPHA_SAT) {
                    // 饱和区域：用 W_rgb 已完全覆盖，像素信息丢失。先留空，外部可用 LaMa 补
                    // 这里暂且保持原 output，视觉上最小改动
                    continue;
                }
                const inv = 1 / (1 - a);
                // original = (output - W_rgb * α) / (1 - α)
                for (let c = 0; c < 3; c++) {
                    const recovered = (d[p + c] - W_rgb[c] * a) * inv;
                    d[p + c] = Math.max(0, Math.min(255, Math.round(recovered)));
                }
                applied++;
            }
        }
        ctx.putImageData(roi, tx, ty);
        return { applied, box: { x: tx, y: ty, w: box.w, h: box.h } };
    }

    window.GeminiReverseAlpha = { calibrateFromImage, applyTemplate };
})();
