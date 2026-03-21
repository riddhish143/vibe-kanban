#!/bin/bash

set -e  # Exit on any error

DESKTOP_MODE=false
BUILD_DESKTOP=false

for arg in "$@"; do
  case "$arg" in
    -d|--desktop)
      DESKTOP_MODE=true
      BUILD_DESKTOP=true
      ;;
    --all)
      DESKTOP_MODE=true
      BUILD_DESKTOP=true
      ;;
    -h|--help)
      echo "Usage: ./local-build.sh [-d|--desktop] [--all]"
      echo ""
      echo "  default        Build locally and launch browser mode"
      echo "  -d, --desktop  Build desktop artifacts and launch desktop mode"
      echo "  --all          Build desktop artifacts and launch desktop mode"
      exit 0
      ;;
    *)
      echo "❌ Unknown argument: $arg"
      echo "Usage: ./local-build.sh [-d|--desktop] [--all]"
      exit 1
      ;;
  esac
done

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Map architecture names
case "$ARCH" in
  x86_64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    echo "⚠️  Warning: Unknown architecture $ARCH, using as-is"
    ;;
esac

# Map OS names
case "$OS" in
  linux)
    OS="linux"
    ;;
  darwin)
    OS="macos"
    ;;
  *)
    echo "⚠️  Warning: Unknown OS $OS, using as-is"
    ;;
esac

PLATFORM="${OS}-${ARCH}"

# Set CARGO_TARGET_DIR if not defined
if [ -z "$CARGO_TARGET_DIR" ]; then
  CARGO_TARGET_DIR="target"
fi

echo "🔍 Detected platform: $PLATFORM"
echo "🔧 Using target directory: $CARGO_TARGET_DIR"

# Set API base URL for remote features
export VK_SHARED_API_BASE="https://api.vibekanban.com"
export VITE_VK_SHARED_API_BASE="https://api.vibekanban.com"

echo "🧹 Cleaning previous builds..."
rm -rf npx-cli/dist
mkdir -p npx-cli/dist/$PLATFORM

echo "🔨 Building web app..."
(cd packages/local-web && npm run build)

echo "🔨 Building Rust binaries..."
cargo build --release --manifest-path Cargo.toml
cargo build --release --bin vibe-kanban-mcp --manifest-path Cargo.toml

echo "📦 Creating distribution package..."

package_binary() {
  local source_path="$1"
  local staged_name="$2"
  local output_zip="$3"
  local temp_dir

  if [ ! -f "$source_path" ]; then
    echo "❌ Missing binary: $source_path"
    exit 1
  fi

  temp_dir=$(mktemp -d)
  cp "$source_path" "$temp_dir/$staged_name"

  (
    cd "$temp_dir"
    zip -q "$OLDPWD/$output_zip" "$staged_name"
  )

  rm -rf "$temp_dir"
}

package_binary \
  "${CARGO_TARGET_DIR}/release/server" \
  "vibe-kanban" \
  "npx-cli/dist/$PLATFORM/vibe-kanban.zip"

package_binary \
  "${CARGO_TARGET_DIR}/release/vibe-kanban-mcp" \
  "vibe-kanban-mcp" \
  "npx-cli/dist/$PLATFORM/vibe-kanban-mcp.zip"

package_binary \
  "${CARGO_TARGET_DIR}/release/review" \
  "vibe-kanban-review" \
  "npx-cli/dist/$PLATFORM/vibe-kanban-review.zip"

echo "✅ CLI build complete!"
echo "📁 Files created:"
echo "   - npx-cli/dist/$PLATFORM/vibe-kanban.zip"
echo "   - npx-cli/dist/$PLATFORM/vibe-kanban-mcp.zip"
echo "   - npx-cli/dist/$PLATFORM/vibe-kanban-review.zip"

# Optionally build the Tauri desktop app
if [[ "$BUILD_DESKTOP" == true ]]; then
  # Map to Tauri platform naming
  case "$OS" in
    macos) TAURI_OS="darwin" ;;
    linux) TAURI_OS="linux" ;;
    *) TAURI_OS="$OS" ;;
  esac
  case "$ARCH" in
    arm64) TAURI_ARCH="aarch64" ;;
    x64) TAURI_ARCH="x86_64" ;;
    *) TAURI_ARCH="$ARCH" ;;
  esac
  TAURI_PLATFORM="${TAURI_OS}-${TAURI_ARCH}"

  echo ""
  echo "🖥️  Building Tauri desktop app for $TAURI_PLATFORM..."

  # Replace the updater endpoint placeholder with a dummy URL for local builds
  # (CI injects the real R2 URL; locally the updater is non-functional)
  TAURI_CONF="crates/tauri-app/tauri.conf.json"
  node -e "
    const fs = require('fs');
    const conf = JSON.parse(fs.readFileSync('$TAURI_CONF', 'utf8'));
    conf.plugins.updater.endpoints = conf.plugins.updater.endpoints.map(e =>
      e === '__TAURI_UPDATE_ENDPOINT__' ? 'https://localhost/disabled' : e
    );
    fs.writeFileSync('$TAURI_CONF', JSON.stringify(conf, null, 2) + '\n');
  "

  cargo tauri build

  # Restore tauri.conf.json
  git checkout -- "$TAURI_CONF"

  TAURI_DIST="npx-cli/dist/tauri/$TAURI_PLATFORM"
  mkdir -p "$TAURI_DIST"

  BUNDLE_DIR="${CARGO_TARGET_DIR}/release/bundle"
  # Copy updater artifacts (tar.gz bundles or NSIS exe)
  find "$BUNDLE_DIR" -name "*.app.tar.gz" ! -name "*.sig" -exec cp {} "$TAURI_DIST/" \; 2>/dev/null || true
  find "$BUNDLE_DIR" -name "*.AppImage.tar.gz" ! -name "*.sig" -exec cp {} "$TAURI_DIST/" \; 2>/dev/null || true
  find "$BUNDLE_DIR" -name "*-setup.exe" -exec cp {} "$TAURI_DIST/" \; 2>/dev/null || true

  echo "✅ Desktop app built:"
  ls -la "$TAURI_DIST/"
fi

echo ""
echo "🔨 Building npx-cli TypeScript..."
mkdir -p npx-cli/bin
npx esbuild npx-cli/src/cli.ts --bundle --platform=node --target=node20 --format=cjs --outfile=npx-cli/bin/cli.js --external:adm-zip --banner:js="#!/usr/bin/env node"

echo ""
if [[ "$DESKTOP_MODE" == true ]]; then
  echo "🚀 Launching desktop mode..."
  (cd npx-cli && node bin/cli.js --desktop)
else
  echo "🚀 Launching browser mode..."
  (cd npx-cli && node bin/cli.js)
fi
