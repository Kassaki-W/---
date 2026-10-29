@echo off
rem 双击启动：本机起服务并自动打开浏览器（数据保存在本目录 data\ 下）
cd /d "%~dp0"
start "" node.exe src\main.js
