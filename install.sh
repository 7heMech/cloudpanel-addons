#!/usr/bin/env bash
# =============================================================================
# clp-addons bootstrap installer
#
#   curl -fsSL https://raw.githubusercontent.com/7heMech/cloudpanel-addons/v0.1.0/install.sh | bash
#
# Point that URL at a tag, never at main: piping a moving branch into a root
# shell means the script you audited is not necessarily the script that runs.
#
# All prompts read from /dev/tty, not stdin. Under `curl | bash` stdin is the
# pipe carrying this script, so `read` there consumes the script's own text.
# This is the reason Bun's installer is not interactive; reading /dev/tty is
# the fix, and it degrades to --yes when no terminal is attached.
# =============================================================================
set -euo pipefail

REPO="7heMech/cloudpanel-addons"
CLI_ARTIFACT="clp-addons-linux-x64"
CLI_TARGET="/usr/local/bin/clp-addons"
AVAILABLE_ADDONS=("instatic")

VERSION="latest"
SELECTED=""
DOMAIN=""
ASSUME_YES=0
SKIP_ATTESTATION=0

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
  --domain=HOST         hostname for the addon manager's own CloudPanel site
  --version=vX.Y.Z      install a specific release (default: latest)
  --yes                 non-interactive; requires --addons and --domain
  --skip-attestation    accept checksum-only verification
  --help

Available addons: ${AVAILABLE_ADDONS[*]}
USAGE
}

for arg in "$@"; do
  case $arg in
    --addons=*)         SELECTED="${arg#*=}" ;;
    --domain=*)         DOMAIN="${arg#*=}" ;;
    --version=*)        VERSION="${arg#*=}" ;;
    --yes|-y)           ASSUME_YES=1 ;;
    --skip-attestation) SKIP_ATTESTATION=1 ;;
    --help|-h)          usage; exit 0 ;;
    *)                  die "unknown option: $arg" ;;
  esac
done

# --- preflight --------------------------------------------------------------

step "checking this host"

[[ $EUID -eq 0 ]] || die "run as root: this installs a systemd unit and a sudoers drop-in"

case "$(uname -m)" in
  x86_64) ;;
  *) die "unsupported architecture $(uname -m); releases are linux-x64 only" ;;
esac

for c in curl sha256sum sqlite3 systemctl; do
  command -v "$c" >/dev/null || die "required command not found: $c"
done

command -v clpctl >/dev/null || die "clpctl not found; this installer expects a CloudPanel host"

if ! command -v docker >/dev/null; then
  die "docker is not installed. Install it first: curl -fsSL https://get.docker.com | sh"
fi
if ! systemctl is-active --quiet docker; then
  die "docker is installed but not running: systemctl enable --now docker"
fi

# A staging marker means this is a clone of production. Not fatal, but worth
# saying out loud before something writes to a remote destination.
if [[ -r /etc/clp-addons-env ]] && grep -q '^ENVIRONMENT=staging' /etc/clp-addons-env; then
  warn "this box is marked ENVIRONMENT=staging"
fi

ok "host looks suitable ($(uname -srm))"

# --- resolve the release ----------------------------------------------------

api() { curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: clp-addons-installer' "$1"; }

if [[ $VERSION == "latest" ]]; then
  step "resolving the latest release"
  RELEASE_JSON=$(api "https://api.github.com/repos/${REPO}/releases/latest") \
    || die "could not reach the GitHub API to resolve the latest release"
else
  [[ $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || die "--version must look like v0.1.0, got '$VERSION'"
  step "resolving release ${VERSION}"
  RELEASE_JSON=$(api "https://api.github.com/repos/${REPO}/releases/tags/${VERSION}") \
    || die "no such release: ${VERSION}"
fi

# Pull the tag without needing jq, which is not guaranteed on a fresh box.
TAG=$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[[ -n $TAG ]] || die "could not determine the release tag"
ok "release ${TAG}"

BASE="https://github.com/${REPO}/releases/download/${TAG}"

# --- choose addons ----------------------------------------------------------

# /dev/tty rather than stdin, per the header.
have_tty() { [[ -r /dev/tty && -w /dev/tty ]]; }

if [[ -z $SELECTED ]]; then
  if (( ASSUME_YES )) || ! have_tty; then
    die "no addons selected and no terminal to ask on. Pass --addons=${AVAILABLE_ADDONS[0]}"
  fi

  say ""
  say "${B}Which addons should be installed?${N}"
  for i in "${!AVAILABLE_ADDONS[@]}"; do
    printf '  %d) %s\n' "$((i + 1))" "${AVAILABLE_ADDONS[i]}"
  done
  say ""
  printf 'Enter numbers separated by spaces, or "all" [all]: '
  read -r reply < /dev/tty || reply=""
  reply=${reply:-all}

  if [[ $reply == "all" ]]; then
    SELECTED=$(IFS=,; printf '%s' "${AVAILABLE_ADDONS[*]}")
  else
    picked=()
    for n in $reply; do
      [[ $n =~ ^[0-9]+$ ]] || die "not a number: '$n'"
      idx=$((n - 1))
      [[ -n ${AVAILABLE_ADDONS[idx]:-} ]] || die "no addon numbered $n"
      picked+=("${AVAILABLE_ADDONS[idx]}")
    done
    SELECTED=$(IFS=,; printf '%s' "${picked[*]}")
  fi
fi

IFS=',' read -r -a ADDON_LIST <<< "$SELECTED"
(( ${#ADDON_LIST[@]} > 0 )) || die "no addons selected"

for a in "${ADDON_LIST[@]}"; do
  found=0
  for known in "${AVAILABLE_ADDONS[@]}"; do
    [[ $a == "$known" ]] && found=1
  done
  (( found )) || die "unknown addon '$a'. Available: ${AVAILABLE_ADDONS[*]}"
done
ok "installing: ${ADDON_LIST[*]}"

# --- the manager's own hostname ---------------------------------------------

if [[ -z $DOMAIN ]]; then
  if (( ASSUME_YES )) || ! have_tty; then
    die "--domain is required: the addon manager is served as its own CloudPanel site"
  fi
  say ""
  say "${B}Hostname for the addon manager's own site${N}"
  say "${DIM}  A CloudPanel reverse-proxy site is created for it, so it gets SSL, backups${N}"
  say "${DIM}  and per-site security. It must resolve to this server.${N}"
  say ""
  printf 'Hostname: '
  read -r DOMAIN < /dev/tty || DOMAIN=""
fi

[[ $DOMAIN =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] \
  || die "'$DOMAIN' is not a valid lowercase hostname"

# --- fetch and verify the CLI ----------------------------------------------

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

step "downloading ${CLI_ARTIFACT} and SHA256SUMS"
curl -fsSL -o "${TMP}/${CLI_ARTIFACT}" "${BASE}/${CLI_ARTIFACT}" || die "download failed: ${CLI_ARTIFACT}"
curl -fsSL -o "${TMP}/SHA256SUMS" "${BASE}/SHA256SUMS" || die "download failed: SHA256SUMS"

step "verifying the checksum"
expected=$(awk -v f="$CLI_ARTIFACT" '$2 == f || $2 == "*" f { print $1 }' "${TMP}/SHA256SUMS" | head -1)
[[ -n $expected ]] || die "SHA256SUMS does not list ${CLI_ARTIFACT}"
actual=$(sha256sum "${TMP}/${CLI_ARTIFACT}" | awk '{print $1}')
if [[ $expected != "$actual" ]]; then
  die "checksum mismatch for ${CLI_ARTIFACT}
  expected ${expected}
  actual   ${actual}
Refusing to install. The artifact is corrupt or has been substituted."
fi
ok "${CLI_ARTIFACT} matches its recorded checksum"

# The checksum detects corruption. Provenance is what detects substitution,
# since whoever can swap the binary can swap SHA256SUMS beside it.
if (( SKIP_ATTESTATION )); then
  warn "provenance verification skipped"
elif command -v gh >/dev/null; then
  step "verifying build provenance"
  if gh attestation verify "${TMP}/${CLI_ARTIFACT}" --repo "$REPO" >/dev/null 2>&1; then
    ok "provenance verified against ${REPO}"
  else
    die "provenance verification failed. Re-run with --skip-attestation only if you understand why."
  fi
else
  warn "gh is not installed, so provenance was not verified (checksum only)"
  warn "  install the GitHub CLI for the stronger check, or pass --skip-attestation to silence this"
fi

step "installing ${CLI_TARGET}"
install -o root -g root -m 0755 "${TMP}/${CLI_ARTIFACT}" "$CLI_TARGET"
ok "clp-addons $("$CLI_TARGET" --version) installed"

# --- hand off to the CLI ----------------------------------------------------
# The CLI owns installation from here, so there is one implementation of
# "make the box match what should be installed" rather than two.

extra=()
(( SKIP_ATTESTATION )) && extra+=("--skip-attestation")

for addon in "${ADDON_LIST[@]}"; do
  say ""
  step "installing addon: ${addon}"
  "$CLI_TARGET" install "$addon" --domain="$DOMAIN" --version="$TAG" "${extra[@]+"${extra[@]}"}"
done

say ""
ok "done"
say ""
say "${B}Before this is reachable, do these two things in the panel:${N}"
say "  1. ${DOMAIN} → Security → add Basic Auth (and an IP allowlist if you can)."
say "     The manager can create and delete sites; it must not be open."
say "  2. Issue a certificate:"
say "     clpctl lets-encrypt:install:certificate --domainName=${DOMAIN}"
say ""
say "Then check the install with: ${B}clp-addons status${N}"
