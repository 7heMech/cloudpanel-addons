#!/bin/bash
# Managed by clp-addons System Tweaks: hardens CloudPanel's clpctlWrapper so a
# site's Unix user cannot reach outside its own files or data through clpctl.
# Root and clp are already root-equivalent and pass straight through to
# CloudPanel's own wrapper. Every other caller may run only three commands:
#   - db:export writes the dump as the caller (clpctl runs mysqldump | tee as the
#     site user), so a swapped link only redirects a write the caller could make,
#     and its --databaseName must be the caller's own, which clpctl checks.
#   - system:permissions:reset is allowed only on the caller's own home, which is
#     root-parented and so cannot be swapped; find -P and chown -R do not descend
#     into symlinks inside it.
#   - varnish-cache:purge takes no path.
# db:import is refused: clpctl runs the dump through mysql as the database
# administrator, so its SQL could read or change any site's database. Site users
# import with their own database credentials instead. Every option value is
# checked against an allowlist that admits no shell metacharacter. Turning off
# "Block clpctl injection" restores the original byte for byte. Do not edit by hand.
set -u
export LC_ALL=C

# CloudPanel's own wrapper, kept so legitimate commands run exactly as upstream.
ORIG='/var/lib/clp-addons/system-tweaks/clpctlWrapper.orig'

deny() { echo "clpctlWrapper: $1" >&2; exit 1; }

run_original() {
  [ -r "$ORIG" ] || deny "the original clpctl wrapper is missing"
  exec /bin/bash "$ORIG" "$@"
}

caller="${SUDO_USER-}"
# Root and clp can already do anything; restricting them gains nothing and risks
# breaking the panel. clpctl itself reads SUDO_USER the same way.
case "$caller" in
  '' | root | clp) run_original "$@" ;;
esac
[[ "$caller" =~ ^[A-Za-z0-9._-]+$ ]] || deny "unrecognised caller"

# No arguments: let clpctl print its own usage for this caller.
[ "$#" -eq 0 ] && run_original

home="$(getent passwd "$caller" | cut -d: -f6)"
[ -n "$home" ] || deny "no home directory for $caller"
# The home with every symlink resolved. The command runs from here, so clpctl
# resolves a relative path the same way, and it is the one path reset may touch.
home="$(realpath -m -- "$home" 2>/dev/null)"
case "$home" in /*) ;; *) deny "could not resolve the home directory for $caller" ;; esac

command="$1"
shift

case "$command" in
  db:export | system:permissions:reset | varnish-cache:purge) ;;
  db:import) deny "db:import runs as the database administrator, so it is blocked; import with your own database user (phpMyAdmin, or mysql -u<your database user>)" ;;
  *) deny "$caller may not run '$command'" ;;
esac

# A database name: letters, digits, underscore and hyphen only.
check_dbname() {
  [[ "$1" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || deny "--databaseName has characters that are not allowed"
}

# An octal permission mode.
check_mode() {
  [[ "$1" =~ ^[0-7]{3,4}$ ]] || deny "$2 must be an octal mode such as 770"
}

# The export dump path. clpctl writes it as the caller, so a swapped link only
# redirects a write the caller could make anyway; this keeps the value shell-safe
# and, for tidiness, inside the home as clpctl's own check requires.
check_export_file() {
  local val="$1" resolved
  [[ "$val" =~ ^[A-Za-z0-9._/-]+$ ]] || deny "--file has characters that are not allowed"
  case "$val" in
    /*) resolved="$(realpath -m -- "$val" 2>/dev/null)" ;;
    *) resolved="$(realpath -m -- "$home/$val" 2>/dev/null)" ;;
  esac
  case "$resolved" in
    "$home" | "$home"/*) ;;
    *) deny "--file must be inside $home" ;;
  esac
}

# The permissions-reset target. Only the caller's own home: /home/<caller> is
# root-owned at its parent, so the caller cannot swap it for a link, and find -P
# and chown -R do not descend into links inside it. A subfolder could have a
# component swapped after the check, so it is not allowed.
check_reset_path() {
  local val="$1" resolved
  [[ "$val" =~ ^[A-Za-z0-9._/-]+$ ]] || deny "--path has characters that are not allowed"
  case "$val" in
    /*) resolved="$(realpath -m -- "$val" 2>/dev/null)" ;;
    *) resolved="$(realpath -m -- "$home/$val" 2>/dev/null)" ;;
  esac
  [ "$resolved" = "$home" ] || deny "--path may only be your home directory, $home"
}

# A Varnish purge target: all, a tag list, or a plain http(s) URL.
check_purge() {
  local val="$1"
  [ "$val" = all ] && return 0
  [[ "$val" =~ ^(https?://[A-Za-z0-9._~:/-]+|[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*)$ ]] \
    || deny "--purge must be all, a comma-separated tag list, or a plain http(s) URL"
}

final_args=("$command")

while [ "$#" -gt 0 ]; do
  arg="$1"; shift
  name="$arg"; inline=0; val=""
  case "$arg" in
    --*=*) name="${arg%%=*}"; val="${arg#*=}"; inline=1 ;;
  esac

  # Flags that carry no value and are harmless to pass on. An inline value on
  # one is unchecked, so it is refused rather than forwarded.
  case "$name" in
    -n | --no-interaction | -q | --quiet | --ansi | --no-ansi)
      [ "$inline" -eq 0 ] || deny "$name does not take a value"
      final_args+=("$arg"); continue ;;
  esac

  case "$name" in
    --databaseName | --file | --directories | --files | --path | --purge) ;;
    *) deny "option not allowed: $name" ;;
  esac
  if [ "$inline" -eq 0 ]; then
    [ "$#" -gt 0 ] || deny "$name needs a value"
    val="$1"; shift
  fi

  case "$command:$name" in
    db:export:--databaseName) check_dbname "$val"; final_args+=("--databaseName=$val") ;;
    db:export:--file) check_export_file "$val"; final_args+=("--file=$val") ;;
    system:permissions:reset:--directories) check_mode "$val" --directories; final_args+=("--directories=$val") ;;
    system:permissions:reset:--files) check_mode "$val" --files; final_args+=("--files=$val") ;;
    system:permissions:reset:--path) check_reset_path "$val"; final_args+=("--path=$home") ;;
    varnish-cache:purge:--purge) check_purge "$val"; final_args+=("--purge=$val") ;;
    *) deny "$name is not allowed for $command" ;;
  esac
done

# Run from the caller's home, so clpctl resolves a relative export path or a
# defaulted reset path to the home, not to wherever the caller happened to stand.
cd -- "$home" || deny "could not enter $home"
run_original "${final_args[@]}"
