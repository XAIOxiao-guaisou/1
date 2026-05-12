"""LaMa Inpainting Server - 本地离线 FastAPI 服务，为浏览器扩展提供水印擦除能力。"""
import asyncio
import base64
import io
import logging
import sys
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
log = logging.getLogger("lama_server")
def _pick_device() -> str:
    """依次尝试 CUDA → MPS → CPU。环境变量可强制禁用：CUDA_VISIBLE_DEVICES=-1、MPS_DISABLED=1。"""
    import os
    if torch.cuda.is_available() and os.getenv("CUDA_VISIBLE_DEVICES") != "-1":
        log.info("检测到 CUDA 设备，启用 GPU 推理")
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available() and os.getenv("MPS_DISABLED") != "1":
        log.info("检测到 Apple Silicon MPS，使用 MPS 加速")
        return "mps"
    log.info("未检测到可用加速设备，使用 CPU 推理")
    return "cpu"
DEVICE = _pick_device()
MODEL: Optional[nn.Module] = None
# 推理串行化：CPU 下并发会互相拖累，GPU 下显存也吃紧；统一用一把异步锁排队。
INFER_LOCK = asyncio.Lock()
# 请求体上限（字节）；base64 膨胀 ~33%，20 MB 对应原图约 15 MB，足够日常使用。
MAX_BODY_BYTES = 20 * 1024 * 1024
BASE_DIR     = Path(__file__).resolve().parent
MODELS_DIR   = BASE_DIR / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)
torch.hub.set_dir(str(MODELS_DIR))
CACHE_DIR    = MODELS_DIR / "lama_server"
LAMA_PT      = CACHE_DIR / "big-lama" / "models" / "best.ckpt"
LAMA_HUB_DIR = MODELS_DIR / "advimman_lama_main"
@asynccontextmanager
async def lifespan(app: FastAPI):
    global MODEL
    log.info(f"正在加载 LaMa 模型... 设备={DEVICE}")
    try:
        MODEL = _load_lama()
        log.info("✅ LaMa 模型加载成功，服务就绪！")
    except Exception as e:
        log.error(f"❌ 模型加载失败：{e}", exc_info=True)
        log.error("请重启服务重试。")
    yield
    if MODEL is not None and DEVICE == "cuda":
        del MODEL
        torch.cuda.empty_cache()
        log.info("显存已释放。")
app = FastAPI(title="LaMa Inpainting Server", lifespan=lifespan)
# 本服务只为浏览器扩展的 gemini.google.com 内容脚本提供支持，
# 其他来源（包括任意本地页面）默认拒绝，防止被恶意页面打满 CPU。
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://gemini.google.com",
    ],
    allow_origin_regex=r"^chrome-extension://[a-z]{32}$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    """拦截超过 MAX_BODY_BYTES 的请求，避免一个大 POST 直接 OOM。"""
    if request.method == "POST":
        cl = request.headers.get("content-length")
        if cl is not None:
            try:
                if int(cl) > MAX_BODY_BYTES:
                    return JSONResponse(
                        {"detail": f"请求体过大（>{MAX_BODY_BYTES} 字节）"},
                        status_code=413,
                    )
            except ValueError:
                pass
    return await call_next(request)
def _load_lama() -> nn.Module:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if not LAMA_PT.exists():
        _download_lama()
    if not LAMA_HUB_DIR.exists():
        log.info("下载 LaMa 源码到 torch.hub 缓存...")
        try:
            torch.hub.load("advimman/lama", "LaMa",
                           pretrained=False, trust_repo=True, force_reload=False)
        except Exception:
            pass  # hub 可能无 hubconf.py，但 zip 已下载
    model = _build_real_lama()
    log.info(f"加载权重：{LAMA_PT}")
    try:
        import pytorch_lightning  # noqa: F401
    except ImportError:
        raise RuntimeError("缺少 pytorch_lightning！运行：pip install lightning")
    state = torch.load(str(LAMA_PT), map_location="cpu", weights_only=False)
    if "state_dict" in state:
        state = state["state_dict"]
    clean = {k.replace("generator.", "", 1): v
             for k, v in state.items() if k.startswith("generator.")}
    missing, unexpected = model.load_state_dict(clean, strict=False)
    log.info(f"权重加载完成 | missing={len(missing)} unexpected={len(unexpected)}")
    model = model.float().to(DEVICE).eval()
    return model
def _build_real_lama() -> nn.Module:
    """构建 LaMa 生成器结构（FFCResNetGenerator），从 advimman/lama 源码导入。"""
    hub_str = str(LAMA_HUB_DIR)
    if hub_str not in sys.path:
        sys.path.insert(0, hub_str)
    try:
        from saicinpainting.training.modules.ffc import FFCResNetGenerator
        log.info(f"✅ FFCResNetGenerator 导入成功（来源：{LAMA_HUB_DIR}）")
    except ImportError as e:
        raise RuntimeError(
            f"无法导入 FFCResNetGenerator: {e}\n"
            f"请确认 {LAMA_HUB_DIR} 存在，或重新运行安装脚本。"
        )
    model = FFCResNetGenerator(
        input_nc=4,
        output_nc=3,
        ngf=64,
        n_downsampling=3,
        n_blocks=18,
        add_out_act='sigmoid',
        init_conv_kwargs={'ratio_gin': 0, 'ratio_gout': 0, 'enable_lfu': False},
        downsample_conv_kwargs={'ratio_gin': 0, 'ratio_gout': 0, 'enable_lfu': False},
        resnet_conv_kwargs={'ratio_gin': 0.75, 'ratio_gout': 0.75, 'enable_lfu': False},
    )
    return model
def _download_lama():
    from huggingface_hub import hf_hub_download
    log.info("━" * 50)
    log.info("⬇  开始下载 LaMa 模型权重（smartywu/big-lama，约 200MB）")
    log.info("━" * 50)
    sys.stdout.flush()
    downloaded = hf_hub_download(
        repo_id="smartywu/big-lama",
        filename="big-lama.zip",
        local_dir=str(CACHE_DIR),
    )
    log.info(f"✅ 下载完成，正在解压...")
    sys.stdout.flush()
    with zipfile.ZipFile(downloaded, "r") as zf:
        names = zf.namelist()
        for i, name in enumerate(names, 1):
            zf.extract(name, str(CACHE_DIR))
            if i % 10 == 0 or i == len(names):
                log.info(f"   解压进度：{i}/{len(names)}")
                sys.stdout.flush()
    log.info("✅ 解压完成！")
class InpaintRequest(BaseModel):
    image: str
    mask: str
@app.get("/api/v1/model")
async def health():
    return {"model": "big-lama", "device": DEVICE, "ready": MODEL is not None}
@app.post("/api/v1/inpaint")
async def inpaint(req: InpaintRequest):
    if MODEL is None:
        raise HTTPException(503, "模型未就绪，请查看控制台错误信息。")
    try:
        img_pil  = _b64_to_pil(req.image)
        mask_pil = _b64_to_pil(req.mask).convert("L")
    except Exception as e:
        raise HTTPException(400, f"图像解码失败: {e}")
    try:
        # 推理本身是 CPU/GPU 密集型，放到线程池避免阻塞 asyncio；同时全局锁串行化。
        async with INFER_LOCK:
            result = await asyncio.to_thread(_run_inpaint, img_pil, mask_pil)
        return JSONResponse({"image": _pil_to_b64(result)})
    except Exception as e:
        log.error(f"推理失败: {e}", exc_info=True)
        raise HTTPException(500, f"推理失败: {e}")
def _b64_to_pil(b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
def _pil_to_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()
def _run_inpaint(img: Image.Image, mask: Image.Image) -> Image.Image:
    """对 img 执行 LaMa 推理，mask 中白色区域为待修复。

    使用反射填充（reflect padding）让尺寸对齐 8 的倍数，避免 resize 带来的双向采样柔化。
    """
    w, h = img.size
    pad_w = ((w + 7) // 8) * 8
    pad_h = ((h + 7) // 8) * 8

    img_np  = np.array(img, dtype=np.float32) / 255.0  # (H, W, 3)
    mask_np = np.array(mask.convert("L"), dtype=np.float32) / 255.0  # (H, W)

    if (pad_w, pad_h) != (w, h):
        img_np = np.pad(
            img_np,
            ((0, pad_h - h), (0, pad_w - w), (0, 0)),
            mode="reflect",
        )
        mask_np = np.pad(
            mask_np,
            ((0, pad_h - h), (0, pad_w - w)),
            mode="reflect",
        )

    mask_np = (mask_np > 0.5).astype(np.float32)
    masked_img = img_np * (1.0 - mask_np[:, :, None])
    inp_np = np.concatenate([masked_img, mask_np[:, :, None]], axis=2)
    inp_t  = torch.from_numpy(inp_np).permute(2, 0, 1).unsqueeze(0).float().to(DEVICE)

    with torch.no_grad():
        assert MODEL is not None
        out_t = MODEL(inp_t)

    out_np = out_t.squeeze(0).permute(1, 2, 0).cpu().float().numpy()
    out_np = (out_np * 255).clip(0, 255).astype(np.uint8)
    # 裁回原始尺寸，去掉反射填充部分
    out_np = out_np[:h, :w]
    return Image.fromarray(out_np)
if __name__ == "__main__":
    import uvicorn
    log.info(f"▶ LaMa API 服务启动  |  设备={DEVICE}  |  端口=8080")
    uvicorn.run(app, host="127.0.0.1", port=8080, log_level="info")