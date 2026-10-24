#!/usr/bin/env bash
set -euo pipefail

REPO="7heMech/cloudpanel-addons"
CLI_ARTIFACT="clp-addons-linux-x64"
ARTIFACTS=("${CLI_ARTIFACT}")
CLI_TARGET="/usr/local/bin/clp-addons"
GH_PRIVATE="/usr/local/libexec/clp-addons/gh"
VERSION="latest"
SELECTED=""
ASSUME_YES=0
SKIP_ATTESTATION=0

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

  --addons=a,b          install these addons without prompting
  --version=vX.Y.Z      install a specific release (default: latest)
  --yes                 non-interactive; requires --addons
  --skip-attestation    accept checksum-only verification
  --help
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --addons=*)         SELECTED="${arg#*=}" ;;
    --version=*)        VERSION="${arg#*=}" ;;
    --yes|-y)           ASSUME_YES=1 ;;
    --skip-attestation) SKIP_ATTESTATION=1 ;;
    --help|-h)          usage; exit 0 ;;
    *)                  die "unknown option: $arg" ;;
  esac
done

step "checking dependencies (root, CloudPanel)"
[[ $EUID -eq 0 ]] || die "run as root"
[[ $(uname -m) == "x86_64" ]] || die "releases are linux-x64 only"
for command_name in curl sha256sum systemctl tar; do
  command -v "$command_name" >/dev/null || die "required command not found: $command_name"
done
command -v clpctl >/dev/null || die "clpctl not found; this installer expects a CloudPanel host"
ok "dependencies available"

# The binary asks which addons once it is verified, on the terminal this
# script was started from: under `curl | bash` its own stdin is the script.
IFS=',' read -r -a ADDON_LIST <<< "$SELECTED"
if (( ${#ADDON_LIST[@]} == 0 )) && { (( ASSUME_YES )) || [[ ! -r /dev/tty || ! -w /dev/tty ]]; }; then
  die "no addons selected and no terminal to ask on. Pass --addons=panel-tweaks,maintenance"
fi

api() {
  curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: clp-addons-installer' "$1"
}

if [[ $VERSION == "latest" ]]; then
  RELEASE_JSON=$(api "https://api.github.com/repos/${REPO}/releases/latest") || die "could not resolve the latest release"
else
  [[ $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid --version: $VERSION"
  RELEASE_JSON=$(api "https://api.github.com/repos/${REPO}/releases/tags/${VERSION}") || die "no such release: $VERSION"
fi
TAG=$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[[ $TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid release tag: $TAG"
if printf '%s' "$RELEASE_JSON" | grep -q '"prerelease"[[:space:]]*:[[:space:]]*true'; then
  die "${TAG} is a prerelease; use a stable release"
fi
BASE="https://github.com/${REPO}/releases/download/${TAG}"

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

step "downloading and verifying clp-addons ${TAG}"
curl -fsSL -o "${TMP}/SHA256SUMS" "${BASE}/SHA256SUMS" || die "download failed: SHA256SUMS"
for artifact in "${ARTIFACTS[@]}"; do
  curl -fsSL -o "${TMP}/${artifact}" "${BASE}/${artifact}" || die "download failed: ${artifact}"
  expected=$(awk -v f="$artifact" '$2 == f || $2 == "*" f { print $1 }' "${TMP}/SHA256SUMS" | head -1)
  [[ -n $expected ]] || die "SHA256SUMS does not list ${artifact}"
  actual=$(sha256sum "${TMP}/${artifact}" | awk '{print $1}')
  [[ $expected == "$actual" ]] || die "checksum mismatch for ${artifact}"
done
ok "checksums verified"

# This verifier must be bootstrapped before the downloaded binary can run as
# root. Once installed, clp-addons also maintains gh for later release updates.
gh_can_attest() {
  local candidate=$1
  [[ -x $candidate || -n $(command -v "$candidate" 2>/dev/null || true) ]] || return 1
  "$candidate" attestation --help >/dev/null 2>&1
}

find_gh() {
  local candidate
  for candidate in "$GH_PRIVATE" "$(command -v gh 2>/dev/null || true)"; do
    [[ -n $candidate ]] || continue
    if gh_can_attest "$candidate"; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

install_gh() {
  local json tag base tarball destination staged
  json=$(api "https://api.github.com/repos/cli/cli/releases/latest") || return 1
  tag=$(printf '%s' "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  base="https://github.com/cli/cli/releases/download/${tag}"
  tarball="gh_${tag#v}_linux_amd64.tar.gz"

  curl -fsSL -o "${TMP}/${tarball}" "${base}/${tarball}" || return 1
  curl -fsSL -o "${TMP}/gh_checksums.txt" "${base}/gh_${tag#v}_checksums.txt" || return 1
  ( cd "$TMP" && grep " ${tarball}\$" gh_checksums.txt | sha256sum -c --status - ) || return 1
  tar -xzf "${TMP}/${tarball}" -C "$TMP" --no-same-owner --no-same-permissions -- "gh_${tag#v}_linux_amd64/bin/gh" || return 1
  destination=$(dirname "$GH_PRIVATE")
  install -d -o root -g root -m 0755 "$destination" || return 1
  staged=$(mktemp -d "${destination}/.gh-XXXXXX") || return 1
  if ! install -o root -g root -m 0755 "${TMP}/gh_${tag#v}_linux_amd64/bin/gh" "${staged}/gh" ||
     ! gh_can_attest "${staged}/gh" || ! mv -fT "${staged}/gh" "$GH_PRIVATE"; then
    rm -rf "$staged"
    return 1
  fi
  rm -rf "$staged"
  printf '%s' "$tag"
}

if (( SKIP_ATTESTATION )); then
  warn "provenance verification skipped"
else
  GH_BIN=$(find_gh || true)
  if [[ -z $GH_BIN ]]; then
    step "installing GitHub CLI for provenance verification"
    GH_TAG=$(install_gh || true)
    [[ -n $GH_TAG ]] || die "could not install a GitHub CLI with attestation support; use --skip-attestation to accept checksum-only verification"
    GH_BIN="$GH_PRIVATE"
    ok "gh ${GH_TAG} installed"
  fi
  curl -fsSL -o "${TMP}/attestations.jsonl" "${BASE}/attestations.jsonl" || die "release has no attestations.jsonl"
  for artifact in "${ARTIFACTS[@]}"; do
    "$GH_BIN" attestation verify "${TMP}/${artifact}" \
      --bundle "${TMP}/attestations.jsonl" \
      --repo "$REPO" \
      --signer-workflow "${REPO}/.github/workflows/release.yml" \
      >/dev/null 2>&1 || die "provenance verification failed for ${artifact}"
  done
  ok "provenance verified"
fi

install -o root -g root -m 0755 "${TMP}/${CLI_ARTIFACT}" "$CLI_TARGET"
if (( ${#ADDON_LIST[@]} )); then
  "$CLI_TARGET" install "${ADDON_LIST[@]}" --local="$TMP"
else
  "$CLI_TARGET" install --local="$TMP" < /dev/tty
fi
