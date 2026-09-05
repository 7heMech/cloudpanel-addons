#!/usr/bin/env bash
# Phase 3 acceptance: killing a container mid-create must leave no site, no
# container, and no state row behind.
#
# The cleanup path is the interesting part, not the happy path. It has been
# wrong before: an earlier version deleted the CloudPanel site on any failure,
# including when the site pre-existed and the run had only adopted it.
#
# Usage: tools/test-create-interrupt.sh <test-domain>

set -uo pipefail

W=/usr/local/lib/clp-addons/clp-action-instatic
DOMAIN=${1:-interrupt-test.clp-stg.local}
PANEL_DB=/home/clp/htdocs/app/data/db.sq3
STATE=/var/lib/clp-addons/instatic/${DOMAIN}
CONTAINER=instatic-${DOMAIN}

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 2; }

fail=0
check() {
  local label=$1 actual=$2 want=$3
  if [[ $actual == "$want" ]]; then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %s (got %s, wanted %s)\n' "$label" "$actual" "$want"; fail=1
  fi
}

echo "== preparing a clean slate for ${DOMAIN} =="
docker rm -f "$CONTAINER" >/dev/null 2>&1
clpctl site:delete --domainName="$DOMAIN" --force >/dev/null 2>&1
rm -rf "$STATE"
grep -q "$DOMAIN" /etc/hosts || echo "127.0.0.1 $DOMAIN" >> /etc/hosts

echo "== starting create, then killing the container mid-run =="
$W create --domain "$DOMAIN" --port 39100 --tag 0.0.18 > /tmp/create-out.json 2>/tmp/create-err.log &
wrapper_pid=$!

# Wait for the container to exist, then destroy it so the health check fails
# the way a crashing image would.
killed=0
for _ in $(seq 1 120); do
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER"; then
    sleep 2
    docker rm -f "$CONTAINER" >/dev/null 2>&1 && killed=1
    echo "  killed the container mid-create"
    break
  fi
  sleep 1
done
[[ $killed -eq 1 ]] || echo "  note: container never appeared; create failed earlier"

wait $wrapper_pid; rc=$?
echo "  wrapper exit code: $rc"
echo "  reply: $(tail -1 /tmp/create-out.json)"

echo "== nothing may be left behind =="
check "wrapper reported failure" "$([[ $rc -ne 0 ]] && echo yes || echo no)" "yes"
check "no container" "$(docker ps -a --format '{{.Names}}' | grep -Fxc "$CONTAINER")" "0"
check "no CloudPanel site row" \
  "$(sqlite3 -readonly "$PANEL_DB" "SELECT COUNT(*) FROM site WHERE domain_name='${DOMAIN}';")" "0"
check "no vhost on disk" "$([[ -e /etc/nginx/sites-enabled/${DOMAIN}.conf ]] && echo present || echo absent)" "absent"
check "no instance state directory" "$([[ -d $STATE ]] && echo present || echo absent)" "absent"
check "nginx config still valid" "$(nginx -t >/dev/null 2>&1 && echo ok || echo broken)" "ok"

sed -i "/ ${DOMAIN}\$/d" /etc/hosts
rm -f /tmp/create-out.json /tmp/create-err.log
[[ $fail -eq 0 ]] && echo "PASS" || echo "FAIL"
exit $fail
