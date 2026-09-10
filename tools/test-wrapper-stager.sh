#!/usr/bin/env bash
# Wrapper contract tests for the Stager addon.
#
# Same two questions as tools/test-wrapper.sh, for the same reasons:
#
#   1. Hostile input is rejected, and rejection produces no side effects.
#   2. Valid input reaches the verb body.
#
# (2) matters here because of a failure mode specific to these scripts. Under
# `set -e`, a trailing `[[ cond ]] && emit_err "..."` returns 1 when the
# condition is false -- the *success* case -- so the function returns non-zero
# and the shell exits with no output at all. It looks identical to a no-op.
#
# Nothing here creates a site. Every case either fails validation or names a
# domain that does not exist, so the wrapper answers before it reaches clpctl.
#
# Usage: tools/test-wrapper-stager.sh [path-to-wrapper]

set -uo pipefail

W=${1:-/usr/local/libexec/clp-addons/clp-action-stager}
[[ -x $W ]] || { echo "not executable: $W" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 2; }

pass=0 fail=0

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

expect_absent() {
  local label=$1 path=$2
  if [[ -e $path ]]; then
    printf '  FAIL  %s (%s was created)\n' "$label" "$path"; (( fail++ ))
  else
    printf '  ok    %s\n' "$label"; (( pass++ ))
  fi
}

echo "== rejects hostile input =="
expect "shell metacharacters in --source" '"ok":false.*invalid domain for --source' \
  clone --source 'foo.com; touch /tmp/clp-stager-pwned' --target stg.example.test
expect "shell metacharacters in --target" '"ok":false.*invalid domain for --target' \
  clone --source example.test --target 'stg.example.test$(id>/tmp/clp-stager-pwned)'
expect "path traversal in --target" '"ok":false.*invalid domain for --target' \
  clone --source example.test --target '../../../tmp/clp-stager-traversal'
expect "malformed domain label" '"ok":false.*invalid domain for --domain' describe --domain 'bad..example.com'
expect "single-label domain" '"ok":false.*invalid domain for --domain' describe --domain localhost
expect "a domain over 253 characters" '"ok":false.*is too long' \
  describe --domain "$(printf 'a%.0s' {1..250}).example.test"
expect "path traversal in --job" '"ok":false.*invalid job id' job --job '../../etc/shadow'
expect "a job id in the wrong shape" '"ok":false.*invalid job id' job --job 'not-a-job'
expect "an unknown verb" '"ok":false.*unknown verb' frobnicate
expect "an unknown argument" '"ok":false.*unknown argument' sites --wat 1
expect "--tls with a value that is not yes or no" '"ok":false.*takes yes or no' \
  clone --source example.test --target stg.example.test --tls maybe

expect_absent "no file was created by the metacharacter cases" /tmp/clp-stager-pwned
expect_absent "no file was created by the traversal case" /tmp/clp-stager-traversal

echo
echo "== rejects arguments a verb does not take =="
expect "sites takes nothing" '"ok":false.*takes no arguments' sites --domain example.test
expect "describe takes only --domain" '"ok":false.*takes only --domain' \
  describe --domain example.test --source other.test
expect "job takes only --job" '"ok":false.*takes only --job' \
  job --job 20260101T000000Z-abcdef --domain example.test
expect "clone does not take --job" '"ok":false.*clone takes --source' \
  clone --source example.test --target stg.example.test --job 20260101T000000Z-abcdef

echo
echo "== refuses nonsensical clones =="
expect "cloning a site into itself" '"ok":false.*same site' \
  clone --source example.test --target example.test
expect "a source that is not a CloudPanel site" '"ok":false.*no CloudPanel site' \
  clone --source no-such-site.example.test --target stg.no-such-site.example.test
expect "describing a site that does not exist" '"ok":false.*no CloudPanel site' \
  describe --domain no-such-site.example.test

echo
echo "== valid input reaches the verb body =="
expect "sites answers with a list" '"ok":true.*"sites":\[' sites
expect "jobs answers with a list" '"ok":true.*"jobs":\[' jobs
expect "prune answers with a count" '"ok":true.*"removed":[0-9]+' prune
expect "job on an unknown id says so rather than nothing" '"ok":false.*no such job' \
  job --job 20260101T000000Z-abcdef

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
