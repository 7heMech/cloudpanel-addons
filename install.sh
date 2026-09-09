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
# One hostname for all of them. There is one CloudPanel reverse-proxy site and
# one manager behind it, with each addon mounted under its own path, so this is
# asked once however many addons are selected -- and it is one certificate and
# one Basic Auth setup rather than a set per addon.
DOMAIN=""
ASSUME_YES=0
SKIP_ATTESTATION=0
# Deliberately not implied by --yes. That flag means "do not ask me about addons
# and the hostname"; widening it into "add a root-equivalent group and rewrite
# this host's iptables" is exactly the scope creep it should not have.
INSTALL_DOCKER=0
CERTIFICATE="ask"

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
  --domain=HOST         hostname for the CloudPanel site the addons are served
                        from. One site carries all of them, each under its own
                        path, so this is asked once.
  --version=vX.Y.Z      install a specific release (default: latest)
  --yes                 non-interactive; requires --addons and --domain
  --skip-attestation    accept checksum-only verification
  --install-docker      install Docker without asking, if an addon needs it
  --certificate=yes|no request a certificate, or skip (default: ask)
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
    --install-docker)   INSTALL_DOCKER=1 ;;
    --certificate=yes)  CERTIFICATE="yes" ;;
    --certificate=no)   CERTIFICATE="no" ;;
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
  # Anchored at both ends: this becomes a URL path segment and, through the
  # tag, a directory root writes to. Unanchored, 'v1.2.3/../..' passed.
  [[ $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
    || die "--version must look like v0.1.0, got '$VERSION'"
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

  if [[ ${TERM:-dumb} != dumb ]] && [[ -t 1 ]]; then
    # The terminal remains in its normal mode; read only changes it for each key.
    # No dependency downloads, alternate screen, or hidden cursor to restore.
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
      case $key in
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
          fi ;;
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

for a in "${ADDON_LIST[@]}"; do
  found=0
  for known in "${AVAILABLE_ADDONS[@]}"; do
    [[ $a == "$known" ]] && found=1
  done
  (( found )) || die "unknown addon '$a'. Available: ${AVAILABLE_ADDONS[*]}"
done
ok "installing: ${ADDON_LIST[*]}"

# --- what the chosen addons need -------------------------------------------

# Mirrors `requiresUnits` in cli/paths.ts, which is what the CLI itself gates on
# (cli/index.ts). The two used to disagree: this script demanded Docker of
# everyone in its preflight, while `clp-addons install stager` on the same box
# was perfectly happy without it. The stricter of the two was the one with no
# reason to be -- the Stager drives clpctl and tar and never opens a socket to a
# daemon.
addon_needs_docker() {
  local a
  for a in "$@"; do [[ $a == "instatic" ]] && return 0; done
  return 1
}

if addon_needs_docker "${ADDON_LIST[@]}"; then
  if ! command -v docker >/dev/null; then
    say ""
    say "${B}Docker is required by the instatic addon and is not installed.${N}"
    say "${DIM}  Installing it adds a daemon, an apt repository that changes what later${N}"
    say "${DIM}  upgrades pull, a bridge interface, iptables rules, and a docker group${N}"
    say "${DIM}  that is equivalent to root. On a CloudPanel host the firewall rules are${N}"
    say "${DIM}  the part worth thinking about. It is not removed when addons are.${N}"
    say ""
    say "${DIM}  To do it yourself instead: curl -fsSL https://get.docker.com | sh${N}"
    say ""

    if (( ! INSTALL_DOCKER )); then
      if (( ASSUME_YES )) || ! have_tty; then
        die "docker is not installed. Install it first (curl -fsSL https://get.docker.com | sh),
pass --install-docker to have this script do it, or leave instatic out of --addons."
      fi
      printf 'Install Docker now via get.docker.com? [y/N]: '
      read -r reply < /dev/tty || reply=""
      [[ $reply =~ ^[Yy]$ ]] || die "not installing Docker. Re-run without instatic, or install it yourself."
    fi

    step "installing Docker via get.docker.com"
    # Its own directory: TMP is not created until the release is fetched, and a
    # predictable path under /tmp is not somewhere root should be running a
    # script from.
    docker_tmp=$(mktemp -d)
    curl -fsSL https://get.docker.com -o "${docker_tmp}/get-docker.sh" \
      || { rm -rf "$docker_tmp"; die "could not download the Docker install script"; }
    sh "${docker_tmp}/get-docker.sh" || { rm -rf "$docker_tmp"; die "the Docker install script failed"; }
    rm -rf "$docker_tmp"
    command -v docker >/dev/null || die "the Docker install script ran but docker is still not on PATH"
    ok "Docker installed"
  fi

  # Starting a daemon that is already installed is not the same imposition as
  # installing one, so this is done rather than asked about.
  if ! systemctl is-active --quiet docker; then
    step "starting docker"
    systemctl enable --now docker || die "could not start docker: systemctl enable --now docker"
  fi
  ok "docker is active"
fi

# --- the hostname -----------------------------------------------------------

if [[ -z $DOMAIN ]]; then
  if (( ASSUME_YES )) || ! have_tty; then
    die "--domain=HOST is required: it names the CloudPanel site the addons are served from"
  fi
  say ""
  say "${B}Hostname for the addons${N}"
  say "${DIM}  One CloudPanel reverse-proxy site is created for it, so it gets SSL, backups${N}"
  say "${DIM}  and per-site security -- once, not once per addon. Each addon is mounted${N}"
  say "${DIM}  under its own path on it. It must resolve to this server.${N}"
  say ""
  printf 'Hostname: '
  read -r reply < /dev/tty || reply=""
  DOMAIN="$reply"
fi

[[ $DOMAIN =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] \
  || die "'${DOMAIN}' is not a valid lowercase hostname"

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
# `gh attestation` arrived in gh 2.49. Debian bookworm's own package is 2.23,
# which has no such subcommand -- so "is gh installed" was the wrong question
# twice over: it answered no on a stock box, and on a box with Debian's gh it
# answered yes and then failed the verification for a reason that had nothing to
# do with the artifact. Ask what actually matters instead.
gh_can_attest() { [[ -x ${1:-} || -n $(command -v "${1:-}" 2>/dev/null) ]] && "$1" attestation --help >/dev/null 2>&1; }

# A private copy, deliberately not on PATH and not an apt repository. Adding
# cli.github.com to a panel host's sources changes what every future
# `apt upgrade` pulls, which is a much larger footprint than this script has any
# business leaving behind for one verification.
GH_PRIVATE="/usr/local/lib/clp-addons/gh"

find_gh() {
  local candidate
  for candidate in "$GH_PRIVATE" "$(command -v gh 2>/dev/null || true)"; do
    [[ -n $candidate ]] || continue
    if gh_can_attest "$candidate"; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

# Fetch gh itself rather than refusing. This adds no trust assumption: the
# tarball comes from GitHub over the same TLS this script already relies on for
# the artifact, and it is a *different* repository from ours -- so the attacker
# the attestation defends against, one who can replace an asset in our release,
# does not control it. Its own published checksum is checked on the way in.
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
  if ! GH_BIN=$(find_gh); then
    step "installing the GitHub CLI (needed to verify build provenance)"
    if GH_TAG=$(install_gh); then
      GH_BIN="$GH_PRIVATE"
      ok "gh ${GH_TAG} installed to ${GH_PRIVATE}"
    else
      die "build provenance cannot be verified: no gh with 'gh attestation' is
installed, and fetching one from github.com/cli/cli failed.

Provenance is what detects a *substituted* binary. The checksum only detects a
corrupted one, and it travelled down the same channel as the artifact -- while
the next step installs that artifact as root and runs it.

Install gh 2.49 or newer (https://github.com/cli/cli#installation) and re-run,
or, accepting checksum-only verification, re-run with --skip-attestation."
    fi
  fi

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
    # --signer-workflow, not just --repo: with only the repo, any workflow in it
    # that can mint an attestation satisfies the check, so a pull_request or
    # workflow_dispatch job added later would be enough. Releases come from one
    # workflow and this says so.
    if "$GH_BIN" attestation verify "${TMP}/${CLI_ARTIFACT}" \
         --bundle "${TMP}/attestations.jsonl" --repo "$REPO" \
         --signer-workflow "${REPO}/.github/workflows/release.yml" >/dev/null 2>&1; then
      ok "provenance verified against ${REPO}"
    else
      die "provenance verification failed. ${CLI_ARTIFACT} does not match any attestation for ${REPO}."
    fi
  else
    die "no attestations.jsonl in release ${TAG}. Every release artifact is attested, so this
release was not produced by the release workflow. Refusing to install from it."
  fi
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

extra=("--certificate=no")
(( SKIP_ATTESTATION )) && extra+=("--skip-attestation")

# --domain on every one of them: the CLI takes the first as the site to create
# and requires the rest to match it, so passing it each time is a statement of
# intent rather than a chance to disagree with what is already installed.
for addon in "${ADDON_LIST[@]}"; do
  say ""
  step "installing addon: ${addon} at ${DOMAIN}/${addon}"
  "$CLI_TARGET" install "$addon" --domain="$DOMAIN" --version="$TAG" "${extra[@]+"${extra[@]}"}"
done

say ""
ok "done"
say ""
if [[ $CERTIFICATE == ask ]]; then
  if (( ! ASSUME_YES )) && have_tty; then
    say "Request a Let's Encrypt certificate for ${DOMAIN}? DNS must point here."
    printf 'Issue certificate now? [Y/n]: '
    read -r reply < /dev/tty || reply=n
    case $reply in ""|y|Y|yes|YES) CERTIFICATE=yes ;; *) CERTIFICATE=no ;; esac
  else
    CERTIFICATE=no
  fi
fi
if [[ $CERTIFICATE == yes ]]; then
  if clpctl lets-encrypt:install:certificate --domainName="$DOMAIN"; then
    ok "certificate installed for ${DOMAIN}"
  else
    warn "certificate issuance failed; check DNS and retry the command below"
    CERTIFICATE=no
  fi
fi
if [[ $CERTIFICATE == no ]]; then
  warn "No certificate was requested successfully by this installer. HTTPS requires a valid certificate."
  say "  clpctl lets-encrypt:install:certificate --domainName=${DOMAIN}"
fi
say ""
say "${B}Your addons${N}"
for addon in "${ADDON_LIST[@]}"; do
  say "  https://${DOMAIN}/${addon}"
done
say ""
say "Sign in with the manager credential shown during installation."
say "Lost the password? Run: clp-addons auth reset"
say "Optional: restrict access by IP in CloudPanel's site security settings."
say "Check the install with: ${B}clp-addons status${N}"
