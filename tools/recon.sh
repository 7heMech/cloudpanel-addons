#!/usr/bin/env bash
# cloudpanel-addons: read-only reconnaissance
# STRICTLY READ-ONLY. Creates no files outside /tmp, starts nothing, installs
# nothing, never writes to the panel database. Captures no secrets: no password
# hashes, no master DB credentials, no private keys. Skim before sharing.

DB="/home/clp/htdocs/app/data/db.sq3"

hr()  { printf '\n=== %s %s\n' "$1" "$(printf '=%.0s' {1..50})"; }
q()   { printf '\n--- $ %s\n' "$*"; "$@" 2>&1 | sed 's/^/    /'; }
sq()  { printf '\n--- sqlite: %s\n' "$1"; sqlite3 -readonly "$DB" "$1" 2>&1 | sed 's/^/    /'; }
note(){ printf '\n[note] %s\n' "$*"; }

printf 'cloudpanel-addons recon\ndate: %s\nhost: %s\n' "$(date -Is)" "$(hostname)"
[[ $EUID -ne 0 ]] && note "not running as root; several probes will be incomplete"

hr "1. HOST AND BUN COMPILE TARGET"
q uname -srm
q cat /etc/os-release
printf '\n--- $ ldd --version | head -1\n'; ldd --version 2>&1 | head -1 | sed 's/^/    /'
printf '\n--- cpu flags of interest\n'
lscpu 2>/dev/null | tr ',' '\n' | tr ' ' '\n' | grep -ixE 'avx|avx2|avx512f|sse4_2' | sort -u | sed 's/^/    /'
note "no avx2 in that list means you need the baseline bun target"
q nproc
q free -m
printf '\n--- $ df -h / /home /var/lib/docker\n'; df -h / /home /var/lib/docker 2>&1 | sed 's/^/    /'

hr "2. RUNTIMES AND TOOLING"
for c in sqlite3 docker bun node php nginx openssl flock curl jq; do
  printf '    %-9s %s\n' "$c" "$(command -v "$c" 2>/dev/null || echo MISSING)"
done
q docker --version
printf '\n--- $ systemctl is-active docker\n'; systemctl is-active docker 2>&1 | sed 's/^/    /'
printf '\n--- $ docker compose version\n'; docker compose version 2>&1 | head -3 | sed 's/^/    /'
note "docker missing means decide native Bun per site user instead"

hr "3. CLOUDPANEL VERSION AND UPDATE MECHANISM"
q clpctl --version
printf '\n--- $ dpkg -l | grep -i clp\n'; dpkg -l 2>/dev/null | grep -i 'clp\|cloudpanel' | sed 's/^/    /'
printf '\n--- clp-update\n'
for p in /usr/bin/clp-update /usr/local/bin/clp-update; do
  [[ -e $p ]] && { ls -la "$p" | sed 's/^/    /'; file "$p" | sed 's/^/    /'; }
done
printf '\n--- $ ls /etc/apt/sources.list.d/\n'; ls -la /etc/apt/sources.list.d/ 2>&1 | sed 's/^/    /'
printf '\n--- unattended-upgrades enabled?\n'
grep -rhs 'Unattended-Upgrade\|Update-Package-Lists' /etc/apt/apt.conf.d/ 2>/dev/null | sed 's/^/    /'
printf '\n--- cron entries mentioning clp or vhost-templates\n'
grep -rhs 'clp\|vhost-template' /etc/cron.d /etc/crontab /etc/cron.daily /var/spool/cron 2>/dev/null | sed 's/^/    /'
note "a vhost-templates:import cron entry here is the gating question"

hr "4. PANEL FILESYSTEM LAYOUT"
q ls -la /home/clp/htdocs/
q ls -la /home/clp/htdocs/app/
printf '\n--- template and view directories\n'
find /home/clp/htdocs -maxdepth 5 -type d \( -name 'templates' -o -name 'views' -o -name 'Resources' \) 2>/dev/null | sed 's/^/    /'
printf '\n--- twig file count\n'
printf '    %s\n' "$(find /home/clp/htdocs -name '*.twig' 2>/dev/null | wc -l) twig files"
printf '\n--- twig files mentioning site creation or site types\n'
grep -rls --include='*.twig' -iE 'reverse.?proxy|wordpress|site.?type' /home/clp/htdocs 2>/dev/null | head -20 | sed 's/^/    /'
printf '\n--- twig files mentioning the sidebar or nav\n'
grep -rls --include='*.twig' -iE 'sidebar|nav|menu' /home/clp/htdocs 2>/dev/null | head -20 | sed 's/^/    /'
printf '\n--- candidate cache directories\n'
find /home/clp/htdocs -maxdepth 5 -type d \( -name 'cache' -o -name 'var' -o -name 'twig' \) 2>/dev/null | sed 's/^/    /'
printf '\n--- ownership of the panel tree, top two levels\n'
find /home/clp/htdocs -maxdepth 2 -printf '    %M %u:%g %p\n' 2>/dev/null | head -30

hr "5. PANEL DATABASE, SCHEMA ONLY"
q ls -la "$DB"
printf '\n--- $ sqlite3 --version\n'; sqlite3 --version 2>&1 | sed 's/^/    /'
sq ".tables"
sq ".schema site"
sq ".schema php_settings"
printf '\n--- schema lines mentioning a port\n'
sqlite3 -readonly "$DB" '.schema' 2>&1 | grep -i port | sed 's/^/    /'
printf '\n--- schema lines mentioning a template\n'
sqlite3 -readonly "$DB" '.schema' 2>&1 | grep -i 'template' | sed 's/^/    /'
sq "SELECT type, COUNT(*) FROM site GROUP BY type;"
sq "SELECT id, domain_name, type FROM site ORDER BY id;"
note "site.type values above are the closed set we must not add to"
note "NEVER run clpctl db:show:master-credentials, and never SELECT from the user table"

hr "6. VHOST TEMPLATES"
q clpctl vhost-template:list
printf '\n--- on-disk vhost template locations\n'
find / -maxdepth 6 -type d -name '*vhost-template*' 2>/dev/null | sed 's/^/    /'
note "upsert vs truncate is destructive; snapshot the box before testing it"

hr "7. NGINX AND THE PANEL LISTENER"
q nginx -v
printf '\n--- $ ls /etc/nginx/sites-enabled/\n'; ls -la /etc/nginx/sites-enabled/ 2>&1 | sed 's/^/    /'
printf '\n--- $ ls /etc/nginx/sites-available/\n'; ls -la /etc/nginx/sites-available/ 2>&1 | sed 's/^/    /'
printf '\n--- files referencing the panel port 8443\n'
grep -rls '8443' /etc/nginx/ 2>/dev/null | sed 's/^/    /'
printf '\n--- proxy_pass lines already present\n'
grep -rhs 'proxy_pass' /etc/nginx/sites-enabled/ 2>/dev/null | sort -u | sed 's/^/    /'
printf '\n--- nginx config test\n'; nginx -t 2>&1 | sed 's/^/    /'

hr "8. PORTS IN USE AND FIREWALL"
printf '\n--- listening sockets\n'; ss -tlnp 2>/dev/null | sed 's/^/    /'
printf '\n--- anything already in 39000-39999\n'
ss -tln 2>/dev/null | grep -E ':(39[0-9]{3})' | sed 's/^/    /' || printf '    none\n'
printf '\n--- $ ufw status\n'; ufw status 2>&1 | sed 's/^/    /'
printf '\n--- docker published ports\n'
docker ps --format '    {{.Names}}  {{.Ports}}' 2>/dev/null | sed 's/^/    /'
note "any 0.0.0.0 binding above is the ufw bypass decision 2.9 warns about"

hr "9. SUDO AND USER MODEL"
q ls -la /etc/sudoers.d/
printf '\n--- sudoers.d contents\n'
grep -rhs '' /etc/sudoers.d/ 2>/dev/null | sed 's/^/    /'
printf '\n--- $ visudo -c\n'; visudo -c 2>&1 | sed 's/^/    /'
printf '\n--- clp user\n'; id clp 2>&1 | sed 's/^/    /'
printf '\n--- site users present\n'; awk -F: '$3>=1000 && $3<65000 {printf "    %s uid=%s home=%s shell=%s\n",$1,$3,$6,$7}' /etc/passwd

hr "10. SYSTEMD AND EXISTING UNITS"
printf '\n--- units mentioning clp, node, bun or instatic\n'
systemctl list-units --all --no-pager --no-legend 2>/dev/null | grep -iE 'clp|node|bun|instatic' | sed 's/^/    /'
printf '\n--- timers\n'; systemctl list-timers --all --no-pager --no-legend 2>/dev/null | sed 's/^/    /'

hr "END"
printf '\nSkim this file for anything sensitive before sharing it.\n'
