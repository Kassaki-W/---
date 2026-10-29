@echo off
rem 双击启动本地服务（打包前的开发期启动方式）
cd /d "%~dp0"
set NO_BROWSER=
node src\main.js
pause
