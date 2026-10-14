@echo off
chcp 65001 >nul
start "" http://localhost:3000
node server.js
