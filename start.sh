#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
export PORT="${PORT:-20250}"
export HOST="${HOST:-0.0.0.0}"
echo "[KasRAI] Launching on http://${HOST}:${PORT}..."
exec node server.js
