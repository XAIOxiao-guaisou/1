# Gemini Image Downloader Pro (Antigravity V1.8)

Gemini 生成图片的**本地化水印处理工具**：一套 Chrome 扩展 + 本地 Python AI 后端，提供三种处理模式。

## 功能

- **原图模式**：保留完整图像（含水印）
- **安全裁切模式**：按配置裁掉水印区域
- **AI 修复模式**：调用本地 LaMa 模型擦除水印，完全离线、无需联网

## 目录结构

```
Gemini_Extension_v2.0_Win/
├── 1_Chrome_Extension_Plugin/       # Chrome 扩展 (MV3)
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── inject.js
│   ├── sharpen.worker.js
│   ├── popup.html / popup.js
│   ├── options.html
│   └── icons/
└── 2_Python_AI_Backend/             # 本地 FastAPI + LaMa 服务
    ├── lama_server.py
    ├── 启动AI服务.bat
    ├── python/                      # ⚠️ 便携 Python，不在仓库中（见下文）
    └── models/
        ├── advimman_lama_main/      # LaMa 模型源码（精简依赖）
        └── lama_server/             # ⚠️ 运行时权重，不在仓库中（首次启动自动下载）
```

## 运行时依赖（不在 Git 仓库中）

仓库已通过 `.gitignore` 排除以下内容：

| 路径 | 大小 | 如何获得 |
|---|---|---|
| `2_Python_AI_Backend/python/` | ~1.7 GB | 下载 [Python 3.11 embeddable](https://www.python.org/downloads/windows/) 或使用原版压缩包 |
| `2_Python_AI_Backend/models/lama_server/` | ~800 MB | 首次运行 `启动AI服务.bat` 时从 HuggingFace 自动下载 `smartywu/big-lama` |

## 快速上手

### 1. 加载 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 开启右上角"开发者模式"
3. 点"加载已解压的扩展程序"，选择 `1_Chrome_Extension_Plugin/` 目录

### 2. 启动本地 AI 后端（可选，仅 AI 修复模式需要）

1. 将便携 Python 解压到 `2_Python_AI_Backend/python/`
2. 安装依赖（首次）：
   ```cmd
   .\python\python.exe -m pip install torch torchvision fastapi uvicorn pillow numpy pydantic pytorch-lightning huggingface_hub
   ```
3. 双击 `启动AI服务.bat`，首次运行会自动下载模型权重（约 400 MB）

### 3. 使用

1. 访问 [gemini.google.com](https://gemini.google.com/)
2. 生成图像时，右下角会出现"Gemini 助手工作台"面板
3. 选择处理模式 → 点"执行处理并下载"

## 设置说明

扩展图标点击 → "打开设置"，可调节：
- `cutRight` / `cutBottom`：水印包围盒尺寸（圆心 = 距右 cw/2, 距下 ch/2；半径 = min(cw, ch)/2）

## 架构要点

- **前端**：MV3 规范，Worker 加速锐化，MutationObserver 批处理
- **后端**：FastAPI + asyncio 锁串行化推理，反射填充对齐 8 的倍数
- **安全**：CORS 仅白名单 `gemini.google.com` + `chrome-extension://`，20MB 请求上限
- **可用性**：后端离线时自动降级到原图/裁切模式

## 版本

V1.8 - Antigravity 引擎
