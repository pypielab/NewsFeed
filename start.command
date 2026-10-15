#!/bin/bash
# macOS: Finder에서 더블클릭하거나 터미널에서 ./start.command 로 실행
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}"
(sleep 1 && open "http://localhost:$PORT") &
node server.js
