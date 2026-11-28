#!/bin/sh
# Makes this computer a Dori runner of the Toodo server it was downloaded from. The command Settings > Machines &
# accounts > Add a computer shows runs it with DORI_SERVER, DORI_LABEL, DORI_CODE (one-time, 10 minutes) and
# DORI_FINGERPRINT (the supervisor key) in its environment (runner/paste-enroll.ts).
set -u
umask 077
for V in DORI_SERVER DORI_LABEL DORI_CODE DORI_FINGERPRINT; do
  eval "X=\${$V:-}"
  if [ -z "$X" ]; then printf 'Missing %s: copy the whole command from the Toodo web app again.\n' "$V" >&2; exit 1; fi
done
S=${DORI_SERVER%/}
if command -v sha256sum >/dev/null 2>&1; then SUM="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SUM="shasum -a 256"
else echo "Neither sha256sum nor shasum is installed here." >&2; exit 1; fi
TOKEN=$(printf '@TOKEN_TAG@\n%s\n%s' "$DORI_LABEL" "$DORI_CODE" | $SUM | cut -d' ' -f1)
unset DORI_CODE
T=$(mktemp -d) || exit 1
trap 'rm -rf "$T"' EXIT
trap 'exit 130' INT TERM

# get <out file> <curl args...>: true on HTTP 200, else the server's answer is printed.
get() {
  O=$1
  shift
  C=$(curl -sS -o "$O" -w '%{http_code}' -H "X-Dori-Enroll: $TOKEN" "$@") || { echo "Could not reach $S." >&2; return 1; }
  [ "$C" = 200 ] && return 0
  printf 'The Toodo server answered HTTP %s: %s\n' "$C" "$(head -c 400 "$O" 2>/dev/null)" >&2
  return 1
}

fetch() {
  get "$T/install.sh" "$S/runner-enroll/script?label=$DORI_LABEL&shell=posix" || exit 1
  if ! grep -qxF "F='$DORI_FINGERPRINT'" "$T/install.sh"; then
    echo "The downloaded installer does not pin the supervisor key from the command; stopping." >&2
    exit 1
  fi
}

# One install pass, its output shown as it runs (the enrollment request line kept back) and saved; its exit code in E.
pass() {
  { sh "$T/install.sh"; echo $? > "$T/code"; } 2>&1 | tee "$T/out" | grep -v '^RUNNER_ENROLL_REQUEST '
  E=$(cat "$T/code")
}

echo "Installing the Dori runner $DORI_LABEL from $S ..."
fetch
pass
if [ "$E" = 9 ]; then
  REQ=$(sed -n 's/^RUNNER_ENROLL_REQUEST //p' "$T/out" | tail -n 1)
  get "$T/answer" -X POST -H 'content-type: text/plain' --data-binary "$REQ" "$S/runner-enroll/exchange?label=$DORI_LABEL" || exit 5
  echo "The supervisor accepted this computer. Finishing the install ..."
  fetch
  pass
fi
case "$E" in
  0) echo "Done: $DORI_LABEL is a Dori runner. It shows as connected in Settings > Machines & accounts once the server reaches it over the LAN or Tailscale." ;;
  3) echo "No usable bun: on Linux, install bun (https://bun.sh) so it is on the PATH, then make a new command in the web app." >&2 ;;
  4) echo "This system cannot take a runner: Linux and macOS can (Windows takes the PowerShell command)." >&2 ;;
  5) echo "The enrollment was refused: make a new command in the web app and run it within 10 minutes." >&2 ;;
  6) echo "The service manager (systemd or launchd) refused the runner service; see the lines above." >&2 ;;
  7) echo "hc is not on your login PATH: install it (curl -fsSL @HC_INSTALL_URL@ | sh), open a new terminal, then make a new command in the web app." >&2 ;;
  8) echo "This is a POSIX shell on Windows: run the PowerShell command from the web app instead." >&2 ;;
  *) echo "The install failed with exit code $E; see the lines above." >&2 ;;
esac
exit "$E"
