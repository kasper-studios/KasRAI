#!/usr/bin/env bash
cd "$(dirname "$0")"

# Acquire Termux wakelock so Android doesn't kill gateway when screen is off
if command -v termux-wake-lock >/dev/null 2>&1; then
  echo "[KasRAI] Acquiring Termux wake-lock..."
  termux-wake-lock
fi

# Check Node version
if ! command -v node >/dev/null 2>&1; then
  echo "[KasRAI] Node.js is not installed! Run: pkg install nodejs"
  exit 1
fi

export PORT="${PORT:-20250}"
export HOST="${HOST:-0.0.0.0}"

echo "=========================================="
echo "⚡ KasRAI Gateway on Termux (Android) ⚡"
echo "• Binding to: http://${HOST}:${PORT}"
echo "• Pure JS runtime (kasdb) — zero native compile required!"
echo "=========================================="

# Auto-restart loop: if server exits with code 0 (GitUpdater FULL RESTART),
# wait 2s for the port to be released then bring it back up automatically.
while true; do
  node --max-old-space-size=256 server.js
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    echo "[KasRAI] Server exited cleanly (restart requested). Restarting in 2s..."
    sleep 2
  else
    echo "[KasRAI] Server crashed (exit $EXIT_CODE). Restarting in 3s..."
    sleep 3
  fi
done
