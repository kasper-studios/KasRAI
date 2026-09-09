#!/data/data/com.termux/files/usr/bin/bash
# Fallback to standard env bash if not in exact Termux bin path
if [ ! -f /data/data/com.termux/files/usr/bin/bash ]; then
  #!/usr/bin/env bash
fi

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

exec node server.js
