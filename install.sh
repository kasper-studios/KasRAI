#!/usr/bin/env bash
# ==============================================================================
# ⚡ KasRAI Universal One-Line Installer (Linux, macOS, Android Termux)
# ==============================================================================
set -e

REPO_URL="https://github.com/kasper-studios/KasRAI.git"
INSTALL_DIR="${HOME}/KasRAI"

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                  ⚡ KasRAI Gateway Setup ⚡               ║"
echo "║             Kasper Route AI Universal Installer           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# 1. Detect environment
IS_TERMUX=false
if [ -n "${TERMUX_VERSION}" ] || [ -d "/data/data/com.termux" ]; then
    IS_TERMUX=true
    echo "[Installer] 📱 Environment: Android Termux detected"
else
    echo "[Installer] 💻 Environment: Linux / Unix Desktop detected"
fi

# 2. Check Node.js & Git
command -v git >/dev/null 2>&1 || {
    echo "[Installer] ❌ Git is not installed!"
    if [ "$IS_TERMUX" = true ]; then
        echo "[Installer] Running: pkg update -y && pkg install git -y"
        pkg update -y && pkg install git -y
    else
        echo "[Installer] Please install git via your package manager (apt/pacman/brew)"
        exit 1
    fi
}

command -v node >/dev/null 2>&1 || {
    echo "[Installer] ❌ Node.js is not installed!"
    if [ "$IS_TERMUX" = true ]; then
        echo "[Installer] Running: pkg install nodejs-lts -y"
        pkg install nodejs-lts -y
    else
        echo "[Installer] Please install Node.js 18+ (https://nodejs.org/)"
        exit 1
    fi
}

echo "[Installer] ✅ Node.js: $(node -v) | Git: $(git --version | head -n1)"

# 3. Clone or Update
if [ -d "${INSTALL_DIR}/.git" ]; then
    echo "[Installer] 🔄 KasRAI directory already exists at ${INSTALL_DIR}. Pulling latest changes..."
    cd "${INSTALL_DIR}"
    git pull origin main || echo "[Installer] (Local modifications preserved)"
else
    echo "[Installer] 📥 Cloning KasRAI repository into ${INSTALL_DIR}..."
    git clone "${REPO_URL}" "${INSTALL_DIR}"
    cd "${INSTALL_DIR}"
fi

# 4. Install pure-JS dependencies
echo "[Installer] 📦 Installing dependencies (Zero-native, pure JavaScript)..."
npm install --omit=dev --no-audit --no-fund

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║             🎉 KasRAI Successfully Installed! 🎉          ║"
echo "╠═══════════════════════════════════════════════════════════╣"
echo "║  To launch KasRAI now:                                    ║"
if [ "$IS_TERMUX" = true ]; then
echo "║    cd ~/KasRAI && bash termux.sh                          ║"
else
echo "║    cd ~/KasRAI && bash start.sh                           ║"
fi
echo "║                                                           ║"
echo "║  Dashboard will be live at:                               ║"
echo "║    👉 http://localhost:20250/                             ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

read -p "🚀 Start KasRAI right now? (y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    if [ "$IS_TERMUX" = true ]; then
        bash termux.sh
    else
        bash start.sh
    fi
fi
