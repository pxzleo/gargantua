@echo off
chcp 65001 >nul
cd /d "%~dp0"
title GARGANTUA LAN server
where node >nul 2>nul
if %errorlevel%==0 (
  node serve.mjs 8080 0.0.0.0
) else (
  echo Node.js not found, using Python. LAN address = http://^<IPv4 below^>:8080/
  ipconfig | findstr /c:"IPv4"
  python -m http.server 8080 --bind 0.0.0.0
)
pause
