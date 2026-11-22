#!/usr/bin/env bash
set -euo pipefail

REPO="7heMech/cloudpanel-addons"
CLI_TARGET="/usr/local/bin/clp-addons"
VERSION="latest"
SELECTED=""

if [[ -t 1 ]]; then
  DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; N=$'\033[0m'
else
  DIM=""; RED=""; GRN=""; YLW=""; N=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s›%s %s\n' "$DIM" "$N" "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$N" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$RED" "$N" "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
clp-addons installer

  --addons=a,b          also enable these addons
  --version=vX.Y.Z      install a specific release (default: latest)
  --help
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --addons=*)  SELECTED="${arg#*=}" ;;
    --version=*) VERSION="${arg#*=}" ;;
    --yes|-y)    ;;
    --help|-h)   usage; exit 0 ;;
    *)           die "unknown option: $arg" ;;
  esac
done

step "checking dependencies (root, CloudPanel)"
[[ $EUID -eq 0 ]] || die "run as root"
case "$(uname -m)" in
  x86_64)        ARTIFACT="clp-addons-linux-x64" ;;
  aarch64|arm64) ARTIFACT="clp-addons-linux-arm64" ;;
  *)             die "unsupported architecture $(uname -m); releases are built for x86_64 and aarch64" ;;
esac
for command_name in curl sha256sum systemctl; do
  command -v "$command_name" >/dev/null || die "required command not found: $command_name"
done
command -v clpctl >/dev/null || die "clpctl not found; this installer expects a CloudPanel host"
ok "dependencies available"

IFS=',' read -r -a ADDON_LIST <<< "$SELECTED"

# GitHub first, so its download counts stay whole; the mirror at cp.7he.dev
# when GitHub cannot be reached, as from an IPv6-only server, since github.com
# has no IPv6. "latest" is the newest release that is not a prerelease, on both.
# A prerelease tag carries a hyphen, so --version refuses one too.
MIRROR="https://cp.7he.dev"
GITHUB="https://github.com/${REPO}/releases"
if [[ $VERSION == "latest" ]]; then
  SOURCES=("${GITHUB}/latest/download" "${MIRROR}/releases/latest")
else
  [[ $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a stable release tag: $VERSION"
  SOURCES=("${GITHUB}/download/${VERSION}" "${MIRROR}/releases/${VERSION}")
fi

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# The checksum catches a broken download. Provenance protects updates, which
# the installed binary verifies; it cannot protect this one, because a
# substituted binary would come with a substituted install.sh.
fetch_from() {
  local base=$1 expected
  curl -fsSL -o "${TMP}/SHA256SUMS" "${base}/SHA256SUMS" || return 1
  curl -fSL --progress-bar -o "${TMP}/${ARTIFACT}" "${base}/${ARTIFACT}" || return 1
  expected=$(awk -v f="$ARTIFACT" '$2 == f || $2 == "*" f { print $1 }' "${TMP}/SHA256SUMS" | head -1)
  [[ -n $expected ]] || { warn "SHA256SUMS does not list ${ARTIFACT}"; return 1; }
  [[ $(sha256sum "${TMP}/${ARTIFACT}" | awk '{print $1}') == "$expected" ]] || { warn "checksum mismatch for ${ARTIFACT}"; return 1; }
}

step "downloading clp-addons ${VERSION}"
fetched=""
for base in "${SOURCES[@]}"; do
  if [[ $base == "${MIRROR}/releases/latest" ]]; then
    tag=$(curl -fsS --max-time 20 "${MIRROR}/latest" 2>/dev/null || true)
    if [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then base="${MIRROR}/releases/${tag}"; else base=""; fi
  fi
  if [[ -n $base ]] && fetch_from "$base"; then fetched="$base"; break; fi
  warn "could not download from ${base:-${MIRROR}}"
done
[[ -n $fetched ]] || die "download failed: ${ARTIFACT}"
ok "checksum verified"

install -o root -g root -m 0755 "${TMP}/${ARTIFACT}" "$CLI_TARGET"
"$CLI_TARGET" install "${ADDON_LIST[@]}" --local="$TMP"
