#!/usr/bin/env bash
# stop-external.sh
# 外部电脑（macOS / Linux）停止 external-client。
# 用法（在项目根目录）：
#   bash scripts/macos/stop-external.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

PID_FILE="$REPO_ROOT/run/external-client.pid"

if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE")"
    if kill "$PID" >/dev/null 2>&1; then
        echo "[stop-external] 已停止 external-client（PID: $PID）。"
    else
        echo "[stop-external] PID $PID 已不在运行。"
    fi
    rm -f "$PID_FILE"
else
    echo "[stop-external] 未找到 PID 文件，尝试按端口查找 ..."
    PID="$(lsof -nP -iTCP:18788 -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "$PID" ]; then
        kill "$PID" && echo "[stop-external] 已停止占用 18788 的进程（PID: $PID）。"
    else
        echo "[stop-external] 没有进程在监听 18788。"
    fi
fi
