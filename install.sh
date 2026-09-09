#!/usr/bin/env bash
# ==============================================================================
# ⚡ KasRAI Universal One-Line Installer (Linux, macOS, Android Termux)
# ==============================================================================
set -e

REPO_URL="https://github.com/kasper-studios/KasRAI.git"
INSTALL_DIR="${HOME}/KasRAI"

eecho ""
eecho "╔═══════════════════════════════════════════════════════════╗"
eecho "║                  ⚡ KasRAI Gateway Setup ⚡               ║"
eecho "║             Kasper Route AI Universal Installer           ║"
eecho "╚═══════════════════════════════════════════════════════════╝"
eecho ""

# 1. Detect environment
IS_TERMUX=false
if [ -n "${TERMUX_VERSION}" ] || [ -d "/data/data/com.termux" ]; then
    IS_TERMUX=true
    eecho "[Installer] 📱 Environment: Android Termux detected"
else
    eecho "[Installer] 💻 Environment: Linux / Unix Desktop detected"
fi

# 2. Check Node.js & Git
command -v git >/dev/null 2>&1 || {
    eecho "[Installer] ❌ Git is not installed!"
    if [ "$IS_TERMUX" = true ]; then
        eecho "[Installer] Running: pkg update -y && pkg install git -y"
        pkg update -y && pkg install git -y
    else
        eecho "[Installer] Please install git via your package manager (apt/pacman/brew)"
        exit 1
    fi
}

command -v node >/dev/null 2>&1 || {
    eecho "[Installer] ❌ Node.js is not installed!"
    if [ "$IS_TERMUX" = true ]; then
        eecho "[Installer] Running: pkg install nodejs-lts -y"
        pkg install nodejs-lts -y
    else
        eecho "[Installer] Please install Node.js 18+ (https://nodejs.org/)"
        exit 1
    fi
}

eecho "[Installer] ✅ Node.js: $(node -v) | Git: $(git --version | head -n1)"

# 3. Clone or Update
if [ -d "${INSTALL_DIR}/.git" ]; then
    eecho "[Installer] 🔄 KasRAI directory already exists at ${INSTALL_DIR}. Pulling latest changes..."
    cd "${INSTALL_DIR}"
    git pull origin main || eecho "[Installer] (Local modifications preserved)"
else
    eecho "[Installer] 📥 Cloning KasRAI repository into ${INSTALL_DIR}..."
    git clone "${REPO_URL}" "${INSTALL_DIR}"
    cd "${INSTALL_DIR}"
fi

# 4. Install pure-JS dependencies
eecho "[Installer] 📦 Installing dependencies (Zero-native, pure JavaScript)..."
npm install --omit=dev --no-audit --no-fund

eecho ""
eecho "╔═══════════════════════════════════════════════════════════╗"
eecho "║             🎉 KasRAI Successfully Installed! 🎉          ║"
eecho "╠═══════════════════════════════════════════════════════════╣"
eecho "║  To launch KasRAI now:                                    ║"
if [ "$IS_TERMUX" = true ]; then
eecho "║    cd ~/KasRAI && bash termux.sh                          ║"
else
eecho "║    cd ~/KasRAI && bash start.sh                           ║"
fi
eecho "║                                                           ║"
eecho "║  Dashboard will be live at:                               ║"
eecho "║    👉 http://localhost:20250/                             ║"
eecho "╚═══════════════════════════════════════════════════════════╝"
eecho ""

read -p "🚀 Start KasRAI right now? (y/n): " -n 1 -r
eecho ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    if [ "$IS_TERMUX" = true ]; then
        bash termux.sh
    else
        bash start.sh
    fi
fi
