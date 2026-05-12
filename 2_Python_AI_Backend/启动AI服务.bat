@echo off
chcp 65001 >nul
title Gemini AI Server - Portable CPU Version
setlocal

echo ============================================================
echo   Gemini AI 水印修复服务（本地 LaMa 推理）
echo   按 Ctrl+C 可随时终止
echo ============================================================
echo.

:loop
echo [%date% %time%] 正在启动服务...
.\python\python.exe lama_server.py
set EXITCODE=%errorlevel%

echo.
echo ------------------------------------------------------------
if %EXITCODE%==0 (
    echo 服务已正常退出。
) else (
    echo 服务异常退出，退出码: %EXITCODE%
)
echo 5 秒后自动重启，按 Ctrl+C 取消...
echo ------------------------------------------------------------
timeout /t 5 /nobreak >nul
goto loop
