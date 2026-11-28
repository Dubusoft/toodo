#!/usr/bin/env bash
# Runs from dori-failure-notify@.service (OnFailure= of the Dori units). Rendered by `dori setup`.
# Posts one line to the owner in the Toodo chat's default room: which unit stopped, free disk on the
# state directory, and the last log lines. Needs no free disk space itself.
set -uo pipefail

unit="${1:-unknown unit}"
cfg="${DORI_CONFIG:-{{CONFIG}}}"
state="$(jq -r '.stateDir // empty' "$cfg" 2>/dev/null)"
case "$state" in
  ""|"~") state="$HOME/.dori/state" ;;
  "~/"*) state="$HOME/${state#"~/"}" ;;
esac
disk="$(df -Pk "$state" 2>/dev/null | awk 'NR==2 { printf "%.1f GB free", $4 / 1048576 }')"
logs="$(journalctl --user -u "$unit" -n 3 --no-pager -o cat 2>/dev/null | tr '\n' ' ' | tr -d '`$' | cut -c1-600)"

text="Dori: $unit failed and systemd stopped restarting it (state disk: ${disk:-unknown}). Last log: ${logs:-none}. After fixing: systemctl --user reset-failed $unit && systemctl --user start $unit"
exec timeout 60 "{{DORI_BIN}}" send --to alerts --text "$text"
