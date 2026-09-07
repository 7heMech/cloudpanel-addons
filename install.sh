#!/usr/bin/env bash
# =============================================================================
# clp-addons bootstrap installer
#
#   curl -fsSL https://github.com/7heMech/cloudpanel-addons/releases/latest/download/install.sh | bash
#
# That URL redirects to the newest release's copy of this script. It is a
# release asset rather than a file read off a branch: piping a moving branch
# into a root shell means the script you audited is not necessarily the script
# that runs, whereas a release asset only changes when a release is cut, is
# listed in that release's SHA256SUMS, and carries the same build provenance
# attestation as the binaries.
#
# To audit before running, or to pin, fetch a specific release instead:
#
#   curl -fsSL -O https://github.com/7heMech/cloudpanel-addons/releases/download/vX.Y.Z/install.sh
#   less install.sh && bash install.sh
#
# See the README for verifying that download's provenance without a GitHub
# account; the same bundle-based check this script performs on the CLI binary.
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
AVAILABLE_ADDONS=("instatic" "stager")

VERSION="latest"
SELECTED=""
DOMAIN=""
# One hostname per addon. Each addon is served as its own CloudPanel
# reverse-proxy site pointing at its own port, so a single --domain shared
# between two of them would put both behind one vhost that only proxies the
# first one's port -- the second manager would be installed and unreachable.
declare -A DOMAIN_FOR=()
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
  --domain=HOST         hostname for the manager's own CloudPanel site.
                        Only when installing a single addon; each addon needs
                        a hostname of its own.
  --domain-ADDON=HOST   hostname for that one addon, e.g. --domain-stager=
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
    --domain-*=*)       key="${arg#--domain-}"; DOMAIN_FOR["${key%%=*}"]="${arg#*=}" ;;
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
# Shape-checked because it is about to be a path component that root writes to,
# not only a URL fragment. The same pattern the CLI applies to a tag.
[[ $TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
  || die "the release tag '${TAG}' is not a version tag this installer will use"
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

# --- a hostname per addon ---------------------------------------------------

# A bare --domain is still the ordinary case, because installing one addon is.
# It is refused for two, rather than quietly applied to both, since the failure
# it produces is a manager that installs cleanly and then answers on somebody
# else's port.
if [[ -n $DOMAIN ]]; then
  if (( ${#ADDON_LIST[@]} > 1 )); then
    die "--domain names one site but ${#ADDON_LIST[@]} addons were selected. Give each its own: $(
      for a in "${ADDON_LIST[@]}"; do printf -- '--domain-%s=HOST ' "$a"; done)"
  fi
  DOMAIN_FOR["${ADDON_LIST[0]}"]="$DOMAIN"
fi

for addon in "${ADDON_LIST[@]}"; do
  if [[ -z ${DOMAIN_FOR[$addon]:-} ]]; then
    if (( ASSUME_YES )) || ! have_tty; then
      die "--domain-${addon}=HOST is required: each addon is served as its own CloudPanel site"
    fi
    say ""
    say "${B}Hostname for the ${addon} manager's own site${N}"
    say "${DIM}  A CloudPanel reverse-proxy site is created for it, so it gets SSL, backups${N}"
    say "${DIM}  and per-site security. It must resolve to this server.${N}"
    say ""
    printf 'Hostname: '
    read -r reply < /dev/tty || reply=""
    DOMAIN_FOR["$addon"]="$reply"
  fi

  [[ ${DOMAIN_FOR[$addon]} =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] \
    || die "'${DOMAIN_FOR[$addon]}' is not a valid lowercase hostname"
done

# Two addons behind one hostname is the same failure as a shared --domain,
# reached by spelling it out twice.
for addon in "${ADDON_LIST[@]}"; do
  for other in "${ADDON_LIST[@]}"; do
    [[ $addon == "$other" ]] && continue
    [[ ${DOMAIN_FOR[$addon]} == "${DOMAIN_FOR[$other]}" ]] \
      && die "${addon} and ${other} were both given ${DOMAIN_FOR[$addon]}; each addon needs its own hostname"
  done
done

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
  # The sigstore bundles are published as a release asset and verified offline.
  # Letting gh reach for the attestations API itself would demand `gh auth
  # login` or GH_TOKEN even for a public repo, putting a GitHub account in the
  # path of every install; fetching the bundles ourselves needs no account and,
  # since they arrive ready to use, no JSON parsing either.
  #
  # Serving the bundles from the release does not weaken anything. A bundle is
  # signed and bound to its subject's digest, so an attacker who can replace an
  # asset cannot produce one that verifies against the replacement.
  if curl -fsSL -o "${TMP}/attestations.jsonl" "${BASE}/attestations.jsonl"; then
    if gh attestation verify "${TMP}/${CLI_ARTIFACT}" \
         --bundle "${TMP}/attestations.jsonl" --repo "$REPO" >/dev/null 2>&1; then
      ok "provenance verified against ${REPO}"
    else
      die "provenance verification failed. ${CLI_ARTIFACT} does not match any attestation for ${REPO}."
    fi
  else
    die "no attestations.jsonl in release ${TAG}. Every release artifact is attested, so this
release was not produced by the release workflow. Refusing to install from it."
  fi
else
  warn "gh is not installed, so provenance was not verified (checksum only)"
  warn "  install the GitHub CLI for the stronger check, or pass --skip-attestation to silence this"
fi

step "installing ${CLI_TARGET}"
install -o root -g root -m 0755 "${TMP}/${CLI_ARTIFACT}" "$CLI_TARGET"
ok "clp-addons $("$CLI_TARGET" --version) installed"

# Put the copy just verified into the release tree, so the CLI's own first fetch
# reuses it rather than downloading the same 78 MiB again. Without this, a
# single-addon bootstrap downloaded the CLI twice: once here, and once by the
# CLI, because its cache looks in the release tree and nothing had created it
# yet. That was a third of the whole bootstrap.
#
# The path has to match RELEASES_DIR in cli/paths.ts, and the mode and ownership
# match what placeRelease writes, so the CLI finds a file indistinguishable from
# one it placed itself. Seeding cannot smuggle anything in: the CLI re-hashes
# whatever it finds against the release's own SHA256SUMS before using it, and
# what is placed here has already been checked against the same file.
RELEASE_DIR="/usr/local/lib/clp-addons/releases/${TAG}"
if install -D -o root -g root -m 0755 \
     "${TMP}/${CLI_ARTIFACT}" "${RELEASE_DIR}/${CLI_ARTIFACT}" 2>/dev/null; then
  ok "seeded ${RELEASE_DIR} so ${CLI_ARTIFACT} is not fetched twice"
else
  # Not fatal. The CLI will download its own copy, which is what happened before
  # this existed.
  warn "could not seed ${RELEASE_DIR}; the CLI will download its own copy"
fi

# --- hand off to the CLI ----------------------------------------------------
# The CLI owns installation from here, so there is one implementation of
# "make the box match what should be installed" rather than two.

extra=()
(( SKIP_ATTESTATION )) && extra+=("--skip-attestation")

for addon in "${ADDON_LIST[@]}"; do
  say ""
  step "installing addon: ${addon} at ${DOMAIN_FOR[$addon]}"
  "$CLI_TARGET" install "$addon" --domain="${DOMAIN_FOR[$addon]}" --version="$TAG" "${extra[@]+"${extra[@]}"}"
done

say ""
ok "done"
say ""
say "${B}Before these are reachable, do these two things in the panel for each:${N}"
for addon in "${ADDON_LIST[@]}"; do
  say ""
  say "  ${B}${DOMAIN_FOR[$addon]}${N} (${addon})"
  say "  1. Security → add Basic Auth (and an IP allowlist if you can)."
  say "     A manager can create and delete sites; it must not be open."
  say "  2. Issue a certificate:"
  say "     clpctl lets-encrypt:install:certificate --domainName=${DOMAIN_FOR[$addon]}"
done
say ""
say "Then check the install with: ${B}clp-addons status${N}"
