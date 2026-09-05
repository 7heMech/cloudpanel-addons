#!/usr/bin/env bash
# Wrapper contract tests.
#
# Two things are checked, and the second is the one that has actually broken:
#
#   1. Hostile input is rejected, and rejection produces no side effects.
#   2. Valid input reaches the verb body.
#
# (2) exists because of a silent failure mode specific to this script. Under
# `set -e`, a trailing `[[ cond ]] && emit_err "..."` returns 1 when the
# condition is false — the *success* case — so the function returns non-zero
# and the shell exits with no output at all. It looks identical to a no-op.
# Asserting that each verb emits *something* catches it; asserting only that
# bad input is rejected does not.
#
# Usage: tools/test-wrapper.sh [path-to-wrapper]

set -uo pipefail

W=${1:-/usr/local/lib/clp-addons/clp-action-instatic}
[[ -x $W ]] || { echo "not executable: $W" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 2; }

pass=0 fail=0

# Assert the JSON reply matches a pattern.
expect() {
  local label=$1 pattern=$2; shift 2
  local out
  out=$("$W" "$@" 2>/dev/null | tail -1)
  if [[ $out =~ $pattern ]]; then
    printf '  ok    %s\n' "$label"
    (( pass++ ))
  else
    printf '  FAIL  %s\n        wanted /%s/\n        got    %s\n' "$label" "$pattern" "${out:-<no output>}"
    (( fail++ ))
  fi
}

# Assert a file does not exist.
expect_absent() {
  local label=$1 path=$2
  if [[ -e $path ]]; then
    printf '  FAIL  %s (%s was created)\n' "$label" "$path"; (( fail++ ))
  else
    printf '  ok    %s\n' "$label"; (( pass++ ))
  fi
}

echo "== rejects hostile input =="
expect "shell metacharacters in --domain" '"ok":false.*invalid domain' \
  create --domain 'foo.com; touch /tmp/clp-test-pwned' --port 39000 --tag 0.0.18
expect "path traversal in --domain" '"ok":false.*invalid domain' \
  stop --domain '../../../tmp/clp-test-traversal'
expect "uppercase domain" '"ok":false.*invalid domain' stop --domain 'BAD.EXAMPLE.COM'
expect "single-label domain" '"ok":false.*invalid domain' stop --domain 'localhost'
expect "port below the reserved range" '"ok":false.*outside reserved range' \
  create --domain a.example.com --port 8080 --tag 0.0.18
expect "port above the reserved range" '"ok":false.*outside reserved range' \
  create --domain a.example.com --port 40000 --tag 0.0.18
expect "non-numeric port" '"ok":false.*(must be an integer|outside reserved)' \
  create --domain a.example.com --port 39000x --tag 0.0.18
expect "tag 'latest'" '"ok":false.*exact version' \
  create --domain a.example.com --port 39000 --tag latest
expect "tag as a branch name" '"ok":false.*exact version' \
  create --domain a.example.com --port 39000 --tag main
expect "unknown flag" '"ok":false.*unknown argument' \
  create --domain a.example.com --port 39000 --tag 0.0.18 --registry evil.io
expect "unknown verb" '"ok":false.*unknown verb' exec --domain a.example.com
expect "flag without a value" '"ok":false.*needs a value' stop --domain
expect "delete confirm mismatch" '"ok":false.*confirm must equal' \
  delete --domain a.example.com --confirm b.example.com
expect "update rejects --port" '"ok":false.*does not take --port' \
  update --domain a.example.com --port 39000 --tag 0.0.18
expect "stop rejects --tag" '"ok":false.*takes only --domain' \
  stop --domain a.example.com --tag 0.0.18

echo "== rejection leaves nothing behind =="
expect_absent "no file from the injection attempt" /tmp/clp-test-pwned
expect_absent "no lock file outside the lock dir" /tmp/clp-test-traversal.lock

echo "== valid input reaches the verb body =="
# Each of these must produce a reply. Silence means the set -e regression is
# back and the verb is exiting before it runs.
NOPE=absent-instance.example.com
expect "start reaches the body"    '"ok":(true|false)' start    --domain "$NOPE"
expect "stop reaches the body"     '"ok":(true|false)' stop     --domain "$NOPE"
expect "restart reaches the body"  '"ok":(true|false)' restart  --domain "$NOPE"
expect "status reaches the body"   '"ok":true.*absent' status   --domain "$NOPE"
expect "logs reaches the body"     '"ok":(true|false)' logs     --domain "$NOPE"
expect "snapshot reaches the body" '"ok":(true|false)' snapshot --domain "$NOPE"
expect "update reaches the body"   '"ok":false.*no such instance' \
  update --domain "$NOPE" --tag 0.0.18
expect "delete reaches the body"   '"ok":(true|false)' \
  delete --domain "$NOPE" --confirm "$NOPE"

# create is the one verb whose body has side effects, so stop it at its first
# guard rather than letting it build anything.
if docker ps -a --format '{{.Names}}' | grep -q '^instatic-'; then
  existing=$(docker ps -a --format '{{.Names}}' | grep '^instatic-' | head -1 | sed 's/^instatic-//')
  expect "create reaches the body" '"ok":false.*already exists' \
    create --domain "$existing" --port 39999 --tag 0.0.18
else
  echo "  skip  create reaches the body (no existing instance to collide with)"
fi

echo "== self-site guard =="
own=$(sed -n 's/^[[:space:]]*OWN_DOMAIN[[:space:]]*=[[:space:]]*//p' /etc/clp-addons/instatic.conf 2>/dev/null | tail -1 | tr -d '[:space:]')
if [[ -n $own ]]; then
  expect "refuses the addon's own site" '"ok":false.*own site' delete --domain "$own" --confirm "$own"
else
  echo "  skip  self-site guard (no OWN_DOMAIN configured)"
fi

rm -f /run/lock/clp-addons/*.lock 2>/dev/null

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
