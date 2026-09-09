#!/usr/bin/env bash
set -euo pipefail

REPO="7heMech/cloudpanel-addons"
CLI_ARTIFACT="clp-addons-linux-x64"
ARTIFACTS=("${CLI_ARTIFACT}" "clp-action-instatic" "clp-action-stager" "clp-verify-session")
CLI_TARGET="/usr/local/bin/clp-addons"
GH_PRIVATE="/usr/local/libexec/clp-addons/gh"
AVAILABLE_ADDONS=("instatic" "stager")
VERSION="latest"
SELECTED=""
ASSUME_YES=0
SKIP_ATTESTATION=0
INSTALL_DOCKER=0

if [[ -t 1 ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; N=$'\033[0m'
else
  B=""; DIM=""; RED=""; GRN=""; YLW=""; N=""
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
  --install-docker      install Docker if instatic needs it
  --help

Available addons: ${AVAILABLE_ADDONS[*]}
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --addons=*)         SELECTED="${arg#*=}" ;;
    --version=*)        VERSION="${arg#*=}" ;;
    --yes|-y)           ASSUME_YES=1 ;;
    --skip-attestation) SKIP_ATTESTATION=1 ;;
    --install-docker)   INSTALL_DOCKER=1 ;;
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

# --- choose addons ----------------------------------------------------------

have_tty() { [[ -r /dev/tty && -w /dev/tty ]]; }

if [[ -z $SELECTED ]]; then
  if (( ASSUME_YES )) || ! have_tty; then
    die "no addons selected and no terminal to ask on. Pass --addons=${AVAILABLE_ADDONS[0]}"
  fi

  if [[ ${TERM:-dumb} != dumb ]] && [[ -t 1 ]]; then
    selected=(); cursor=0
    for i in "${!AVAILABLE_ADDONS[@]}"; do selected[i]=1; done
    say "Which addons should be installed?"
    say "↑/↓ move · Space toggle · a select all · n clear · Enter install · q cancel"
    while :; do
      for i in "${!AVAILABLE_ADDONS[@]}"; do
        pointer=" "; mark=" "
        (( i == cursor )) && pointer=">"
        (( selected[i] )) && mark="x"
        printf '\r\033[2K %s [%s] %s\n' "$pointer" "$mark" "${AVAILABLE_ADDONS[i]}"
      done
      key=""
      IFS= read -rsn1 key < /dev/tty || die "terminal closed"
      if [[ $key == $'\033' ]]; then
        sequence=""
        IFS= read -rsn2 -t 0.2 sequence < /dev/tty || true
        key+=$sequence
      fi
      case "$key" in
        $'\033[A'|k) cursor=$(( (cursor + ${#AVAILABLE_ADDONS[@]} - 1) % ${#AVAILABLE_ADDONS[@]} )) ;;
        $'\033[B'|j) cursor=$(( (cursor + 1) % ${#AVAILABLE_ADDONS[@]} )) ;;
        ' ') selected[cursor]=$((1 - selected[cursor])) ;;
        a|A) for i in "${!AVAILABLE_ADDONS[@]}"; do selected[i]=1; done ;;
        n|N) for i in "${!AVAILABLE_ADDONS[@]}"; do selected[i]=0; done ;;
        q|Q) die "installation cancelled" ;;
        '')
          picked=()
          for i in "${!AVAILABLE_ADDONS[@]}"; do
            if (( selected[i] )); then picked+=("${AVAILABLE_ADDONS[i]}"); fi
          done
          if (( ${#picked[@]} )); then
            SELECTED=$(IFS=,; printf '%s' "${picked[*]}")
            break
          fi
          ;;
      esac
      printf '\033[%dA' "${#AVAILABLE_ADDONS[@]}"
    done
  else
    say "Which addons should be installed?"
    for i in "${!AVAILABLE_ADDONS[@]}"; do
      printf '  %d) %s\n' "$((i + 1))" "${AVAILABLE_ADDONS[i]}"
    done
    printf 'Enter numbers separated by spaces, or "all" [all]: '
    read -r reply < /dev/tty || die "terminal closed"
    reply=${reply:-all}
    if [[ $reply == all ]]; then
      SELECTED=$(IFS=,; printf '%s' "${AVAILABLE_ADDONS[*]}")
    else
      picked=()
      for n in $reply; do
        [[ $n =~ ^[1-9][0-9]*$ && ${#n} -le 3 ]] || die "not a selection: '$n'"
        idx=$((10#$n - 1))
        [[ -n ${AVAILABLE_ADDONS[idx]:-} ]] || die "no addon numbered $n"
        picked+=("${AVAILABLE_ADDONS[idx]}")
      done
      SELECTED=$(IFS=,; printf '%s' "${picked[*]}")
    fi
  fi
fi

IFS=',' read -r -a ADDON_LIST <<< "$SELECTED"
(( ${#ADDON_LIST[@]} > 0 )) || die "no addons selected"
for addon in "${ADDON_LIST[@]}"; do
  found=0
  for known in "${AVAILABLE_ADDONS[@]}"; do
    [[ $addon == "$known" ]] && found=1
  done
  (( found )) || die "unknown addon '$addon'. Available: ${AVAILABLE_ADDONS[*]}"
done
ok "selected: ${ADDON_LIST[*]}"

addon_needs_docker() {
  local addon
  for addon in "$@"; do [[ $addon == "instatic" ]] && return 0; done
  return 1
}

if addon_needs_docker "${ADDON_LIST[@]}" && ! command -v docker >/dev/null; then
  if (( ! INSTALL_DOCKER )); then
    if (( ASSUME_YES )) || ! have_tty; then
      die "Docker is required by instatic. Install it first or pass --install-docker"
    fi
    printf 'Install Docker now via get.docker.com? [y/N]: '
    read -r reply < /dev/tty || reply=""
    [[ $reply =~ ^[Yy]$ ]] || die "Docker was not installed"
  fi
  docker_tmp=$(mktemp -d)
  trap 'rm -rf "$docker_tmp"' EXIT
  step "installing Docker"
  curl -fsSL https://get.docker.com -o "${docker_tmp}/get-docker.sh" || die "could not download Docker"
  sh "${docker_tmp}/get-docker.sh" || die "Docker installation failed"
  rm -rf "$docker_tmp"
fi
if addon_needs_docker "${ADDON_LIST[@]}"; then
  systemctl is-active --quiet docker || systemctl enable --now docker || die "could not start Docker"
  ok "Docker is active"
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
  local json tag base tarball
  json=$(api "https://api.github.com/repos/cli/cli/releases/latest") || return 1
  tag=$(printf '%s' "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  base="https://github.com/cli/cli/releases/download/${tag}"
  tarball="gh_${tag#v}_linux_amd64.tar.gz"

  curl -fsSL -o "${TMP}/${tarball}" "${base}/${tarball}" || return 1
  curl -fsSL -o "${TMP}/gh_checksums.txt" "${base}/gh_${tag#v}_checksums.txt" || return 1
  ( cd "$TMP" && grep " ${tarball}\$" gh_checksums.txt | sha256sum -c --status - ) || return 1
  tar -xzf "${TMP}/${tarball}" -C "$TMP" || return 1
  install -o root -g root -m 0755 -D "${TMP}/gh_${tag#v}_linux_amd64/bin/gh" "$GH_PRIVATE" || return 1
  gh_can_attest "$GH_PRIVATE" || return 1
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
for addon in "${ADDON_LIST[@]}"; do
  "$CLI_TARGET" install "$addon" --local="$TMP"
done

say ""
ok "Successfully installed!"
say "  Access addons inside CloudPanel at: https://<cloudpanel-host>/addons/"
say "  Check the integration with: clp-addons status"
