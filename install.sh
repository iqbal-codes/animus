#!/bin/sh
set -eu

# install.sh - Fail-closed curl|sh installer for animus
# Installs animus and factory into ANIMUS_INSTALL_DIR ($HOME/.animus/bin by default)
#
# Supported operating systems: Darwin (macOS), Linux
# Supported architectures: arm64 (aarch64), x64 (x86_64)

TMP_DIR=""
cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "${TMP_DIR:-}" ]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup EXIT INT TERM HUP

# 1. Detect and validate Operating System
DETECTED_OS="${ANIMUS_OS:-}"
if [ -z "$DETECTED_OS" ]; then
  UNAME_S=$(uname -s 2>/dev/null || echo "Unknown")
  case "$UNAME_S" in
    Darwin)
      DETECTED_OS="darwin"
      ;;
    Linux)
      DETECTED_OS="linux"
      ;;
    *)
      echo "Error: Unsupported operating system '$UNAME_S'. animus supports Darwin (macOS) and Linux." >&2
      exit 1
      ;;
  esac
else
  case "$DETECTED_OS" in
    darwin|Darwin|macos|macOS|MACOS)
      DETECTED_OS="darwin"
      ;;
    linux|Linux|LINUX)
      DETECTED_OS="linux"
      ;;
    *)
      echo "Error: Unsupported operating system '$DETECTED_OS'. animus supports Darwin (macOS) and Linux." >&2
      exit 1
      ;;
  esac
fi

# 2. Detect and validate Architecture
DETECTED_ARCH="${ANIMUS_ARCH:-}"
if [ -z "$DETECTED_ARCH" ]; then
  UNAME_M=$(uname -m 2>/dev/null || echo "Unknown")
  case "$UNAME_M" in
    arm64|aarch64)
      DETECTED_ARCH="arm64"
      ;;
    x86_64|amd64)
      DETECTED_ARCH="x64"
      ;;
    *)
      echo "Error: Unsupported architecture '$UNAME_M'. animus supports arm64 (aarch64) and x64 (x86_64)." >&2
      exit 1
      ;;
  esac
else
  case "$DETECTED_ARCH" in
    arm64|aarch64|ARM64|AARCH64)
      DETECTED_ARCH="arm64"
      ;;
    x64|x86_64|amd64|X64|X86_64|AMD64)
      DETECTED_ARCH="x64"
      ;;
    *)
      echo "Error: Unsupported architecture '$DETECTED_ARCH'. animus supports arm64 (aarch64) and x64 (x86_64)." >&2
      exit 1
      ;;
  esac
fi

# 3. Resolve target release version
ANIMUS_REPO="${ANIMUS_REPO:-iqbal-codes/animus}"
VERSION="${ANIMUS_VERSION:-}"
if [ -n "$VERSION" ]; then
  VERSION="${VERSION#v}"
fi

if [ -z "$VERSION" ]; then
  LATEST_URL="https://api.github.com/repos/${ANIMUS_REPO}/releases/latest"
  echo "Resolving latest release version from ${LATEST_URL}..."
  LATEST_JSON=$(curl -fsSL "${LATEST_URL}" 2>/dev/null || true)
  if [ -n "$LATEST_JSON" ]; then
    TAG_NAME=$(printf "%s\n" "$LATEST_JSON" | grep '"tag_name":' | head -n 1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    VERSION="${TAG_NAME#v}"
  fi
fi

if [ -z "$VERSION" ]; then
  echo "Error: Could not resolve target release version. Please specify ANIMUS_VERSION (e.g. ANIMUS_VERSION=0.2.0)." >&2
  exit 1
fi

# 4. Resolve download URLs and filenames
RELEASE_BASE_URL="${ANIMUS_RELEASE_BASE_URL:-https://github.com/${ANIMUS_REPO}/releases/download/v${VERSION}}"
RELEASE_BASE_URL="${RELEASE_BASE_URL%/}"

TARBALL_NAME="animus-v${VERSION}-${DETECTED_OS}-${DETECTED_ARCH}.tar.gz"
TARBALL_URL="${RELEASE_BASE_URL}/${TARBALL_NAME}"
CHECKSUMS_URL="${RELEASE_BASE_URL}/checksums.txt"

# 5. Resolve target install directory
ANIMUS_INSTALL_DIR="${ANIMUS_INSTALL_DIR:-${HOME}/.animus/bin}"
ANIMUS_INSTALL_DIR="${ANIMUS_INSTALL_DIR%/}"

# 6. Setup temporary directory for download & verification
TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'animus-install')
if [ -z "$TMP_DIR" ] || [ ! -d "$TMP_DIR" ]; then
  echo "Error: Failed to create temporary directory for installation." >&2
  exit 1
fi

download() {
  _url="$1"
  _dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$_url" -o "$_dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$_dest" "$_url"
  else
    echo "Error: Neither curl nor wget is available. Cannot download release artifacts." >&2
    exit 1
  fi
}

echo "Downloading checksums.txt from ${CHECKSUMS_URL}..."
if ! download "$CHECKSUMS_URL" "$TMP_DIR/checksums.txt"; then
  echo "Error: Failed to download checksums.txt from ${CHECKSUMS_URL}." >&2
  exit 1
fi

if [ ! -s "$TMP_DIR/checksums.txt" ]; then
  echo "Error: Downloaded checksums.txt is empty." >&2
  exit 1
fi

echo "Downloading ${TARBALL_NAME} from ${TARBALL_URL}..."
if ! download "$TARBALL_URL" "$TMP_DIR/${TARBALL_NAME}"; then
  echo "Error: Failed to download release tarball from ${TARBALL_URL}." >&2
  exit 1
fi

# 7. Fail-closed Checksum Verification
EXPECTED_SHA=$(awk -v target="$TARBALL_NAME" '
  $2 == target || $2 == ("*" target) || $2 == ("./" target) {
    print $1;
    exit;
  }
' "$TMP_DIR/checksums.txt")

if [ -z "$EXPECTED_SHA" ]; then
  echo "Error: Checksum entry for '${TARBALL_NAME}' not found in checksums.txt." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA=$(sha256sum "$TMP_DIR/${TARBALL_NAME}" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA=$(shasum -a 256 "$TMP_DIR/${TARBALL_NAME}" | awk '{print $1}')
else
  echo "Error: Neither sha256sum nor shasum is available for SHA-256 verification." >&2
  exit 1
fi

EXPECTED_SHA=$(printf "%s" "$EXPECTED_SHA" | tr '[:upper:]' '[:lower:]')
ACTUAL_SHA=$(printf "%s" "$ACTUAL_SHA" | tr '[:upper:]' '[:lower:]')

if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "Error: SHA-256 digest verification failed for '${TARBALL_NAME}'!" >&2
  echo "  Expected: ${EXPECTED_SHA}" >&2
  echo "  Actual:   ${ACTUAL_SHA}" >&2
  exit 1
fi

echo "Checksum verified: ${ACTUAL_SHA}"

# 8. Extract and Install
EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "$EXTRACT_DIR"

if ! tar -xzf "$TMP_DIR/${TARBALL_NAME}" -C "$EXTRACT_DIR"; then
  echo "Error: Failed to extract ${TARBALL_NAME}." >&2
  exit 1
fi

if [ ! -f "$EXTRACT_DIR/animus" ]; then
  echo "Error: Tarball does not contain animus binary." >&2
  exit 1
fi

mkdir -p "$ANIMUS_INSTALL_DIR"
cp -f "$EXTRACT_DIR/animus" "$ANIMUS_INSTALL_DIR/animus"
chmod 0755 "$ANIMUS_INSTALL_DIR/animus"

# Ensure factory and animus aliases exist
for alias_name in factory; do
  if [ -f "$EXTRACT_DIR/$alias_name" ]; then
    cp -f "$EXTRACT_DIR/$alias_name" "$ANIMUS_INSTALL_DIR/$alias_name"
    chmod 0755 "$ANIMUS_INSTALL_DIR/$alias_name"
  else
    (cd "$ANIMUS_INSTALL_DIR" && ln -sf "animus" "$alias_name")
  fi
done

# 9. Verify installed binary
if [ -x "$ANIMUS_INSTALL_DIR/animus" ]; then
  VER_OUT=$("$ANIMUS_INSTALL_DIR/animus" version 2>/dev/null || true)
  if [ -n "$VER_OUT" ]; then
    echo "Verified installation: ${VER_OUT}"
  fi
fi

# 10. Check PATH and print instructions if needed
case ":${PATH:-}:" in
  *":${ANIMUS_INSTALL_DIR}:"*)
    ;;
  *)
    echo ""
    echo "Notice: ${ANIMUS_INSTALL_DIR} is not in your PATH."
    echo "To use 'animus' and 'factory' from your terminal, add it to your PATH:"
    echo "  export PATH=\"${ANIMUS_INSTALL_DIR}:\$PATH\""
    echo ""
    ;;
esac

echo "Successfully installed animus into ${ANIMUS_INSTALL_DIR}."
