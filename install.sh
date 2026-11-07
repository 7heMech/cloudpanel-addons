#!/usr/bin/env bash
set -euo pipefail

REPO="7heMech/cloudpanel-addons"
ARTIFACT="clp-addons-linux-x64"
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
[[ $(uname -m) == "x86_64" ]] || die "releases are linux-x64 only"
for command_name in curl sha256sum systemctl; do
  command -v "$command_name" >/dev/null || die "required command not found: $command_name"
done
command -v clpctl >/dev/null || die "clpctl not found; this installer expects a CloudPanel host"
ok "dependencies available"

IFS=',' read -r -a ADDON_LIST <<< "$SELECTED"

# /releases/latest is the newest release that is not a prerelease. A
# prerelease tag carries a hyphen, so --version refuses one too.
if [[ $VERSION == "latest" ]]; then
  BASE="https://github.com/${REPO}/releases/latest/download"
else
  [[ $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a stable release tag: $VERSION"
  BASE="https://github.com/${REPO}/releases/download/${VERSION}"
fi

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# The checksum catches a broken download. Provenance protects updates, which
# the installed binary verifies; it cannot protect this one, because a
# substituted binary would come with a substituted install.sh.
step "downloading clp-addons ${VERSION}"
curl -fsSL -o "${TMP}/SHA256SUMS" "${BASE}/SHA256SUMS" || die "download failed: SHA256SUMS"
curl -fSL --progress-bar -o "${TMP}/${ARTIFACT}" "${BASE}/${ARTIFACT}" || die "download failed: ${ARTIFACT}"
expected=$(awk -v f="$ARTIFACT" '$2 == f || $2 == "*" f { print $1 }' "${TMP}/SHA256SUMS" | head -1)
[[ -n $expected ]] || die "SHA256SUMS does not list ${ARTIFACT}"
[[ $(sha256sum "${TMP}/${ARTIFACT}" | awk '{print $1}') == "$expected" ]] || die "checksum mismatch for ${ARTIFACT}"
ok "checksum verified"

install -o root -g root -m 0755 "${TMP}/${ARTIFACT}" "$CLI_TARGET"
"$CLI_TARGET" install "${ADDON_LIST[@]}" --local="$TMP"
