#!/usr/bin/env bash
# start-external.sh
# 外部电脑（macOS / Linux）一键启动 external-client，并做一次链路自检。
# 用法（在项目根目录）：
#   bash scripts/macos/start-external.sh
# 或赋予执行权限后：
#   ./scripts/macos/start-external.sh

set -euo pipefail

# 定位项目根目录（脚本在 scripts/macos/ 下，向上两级）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

echo "[start-external] 项目根目录: $REPO_ROOT"

# 1. 检查 .env
if [ ! -f ".env" ]; then
    echo "[start-external] 找不到 .env，请先复制 .env.example 为 .env 并填写 REMOTE_BASE_URL / BRIDGE_TOKEN。"
    exit 1
fi

# 从 .env 读取指定 key（去掉引号和首尾空格）
read_env() {
    local key="$1"
    local line
    line="$(grep -E "^\s*${key}\s*=" .env | head -n1 || true)"
    [ -z "$line" ] && return 0
    local val="${line#*=}"
    # 去首尾空格
    val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    # 去成对引号
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    echo "$val"
}

# 2. 解析端口
ADDR="$(read_env EXTERNAL_LISTEN_ADDR)"
if [ -n "$ADDR" ]; then
    PORT="${ADDR##*:}"
else
    PORT="18788"
fi
HEALTH_URL="http://127.0.0.1:${PORT}/healthz"
echo "[start-external] external-client 端口: $PORT"

# 3. 端口占用检查
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[start-external] 端口 $PORT 已被占用。如需停止，运行 bash scripts/macos/stop-external.sh"
    exit 1
fi

# 4. 后台启动 external-client
echo "[start-external] 启动 external-client ..."
mkdir -p "$REPO_ROOT/run" "$REPO_ROOT/logs"
nohup node external-client/server.mjs >> "$REPO_ROOT/logs/external-client.out" 2>&1 &
CLIENT_PID=$!
echo "$CLIENT_PID" > "$REPO_ROOT/run/external-client.pid"
echo "[start-external] external-client 已启动，PID: $CLIENT_PID"

# 5. 健康检查（最多等 15 秒）
echo "[start-external] 等待 external-client 就绪 ..."
READY=0
for _ in $(seq 1 15); do
    sleep 1
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
        READY=1
        break
    fi
done
if [ "$READY" -ne 1 ]; then
    echo "[start-external] external-client 在 15 秒内未通过健康检查，请查看 logs/external-client.out。"
    exit 1
fi
echo "[start-external] external-client 健康检查通过: $HEALTH_URL"

# 6. 链路自检 /debug/probe
KEY="$(read_env EXTERNAL_API_KEY)"
echo "[start-external] 执行链路自检 /debug/probe ..."
if [ -n "$KEY" ]; then
    PROBE="$(curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:${PORT}/debug/probe" || true)"
else
    PROBE="$(curl -s "http://127.0.0.1:${PORT}/debug/probe" || true)"
fi

if echo "$PROBE" | grep -q '"ok":true'; then
    echo "[start-external] 链路自检通过：external-client -> internal-bridge 全部可达。"
else
    echo "[start-external] 链路自检发现问题，原始返回："
    echo "$PROBE"
    echo "[start-external] 请检查 REMOTE_BASE_URL / BRIDGE_TOKEN，以及内部电脑是否已启动。"
fi

echo ""
echo "[start-external] 完成。将客户端 base_url 指向 http://127.0.0.1:${PORT}/openai 即可。"
