#!/usr/bin/env bash
# Installs toodo-server for the current user, from a GitHub release (--release) or built
# from this checkout (the default, for development):
#   ~/.local/bin/toodo-server                     the headless server (MCP + background work)
#   ~/.config/systemd/user/toodo-server.service   a systemd user service (unless --no-service)
#   ~/.local/share/toodo-server-web               the web app: from the release, or built
#                                                 from this checkout with --with-web
# Safe to run again: an update is this script with --release latest (or `git pull` and
# this script for a checkout build). See docs/server.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-server.sh [--release latest|vX.Y.Z] [--listen ADDR] [--no-service]
       scripts/install-server.sh [--listen ADDR] [--no-service] [--with-web]

  --release VER   download toodo-server from the GitHub release VER (latest or vX.Y.Z),
                  check its sha256, and install it; needs no Rust toolchain
  --listen ADDR   address the service listens on (default 127.0.0.1:47616)
  --no-service    install only; do not write or restart the systemd service
  --with-web      build the web app from this checkout too and serve it (needs Node.js
                  and npm); a release installs and serves the web app it carries

Without --release, toodo-server is built from this checkout (needs cargo).
EOF
}

release_repo=dev-bokdong/toodo
release=
# --from-file TARBALL installs a packaged release asset (with TARBALL.sha256 next to it)
# instead of downloading one; for testing scripts/package-server.sh output.
from_file=
listen=127.0.0.1:47616
service=1
web=0
while [ $# -gt 0 ]; do
  case "$1" in
    --release)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      release=$2
      shift 2
      ;;
    --release=*)
      release=${1#--release=}
      shift
      ;;
    --from-file)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      from_file=$2
      shift 2
      ;;
    --listen)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      listen=$2
      shift 2
      ;;
    --listen=*)
      listen=${1#--listen=}
      shift
      ;;
    --no-service)
      service=0
      shift
      ;;
    --with-web)
      web=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

if [ -n "$release" ] && [ -n "$from_file" ]; then
  die "use either --release or --from-file"
fi
if [ -n "$release" ] && [ "$release" != latest ] && ! [[ $release =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "--release takes latest or vX.Y.Z, got '$release'"
fi
from_release=0
{ [ -n "$release" ] || [ -n "$from_file" ]; } && from_release=1
if [ "$from_release" = 1 ] && [ "$web" = 1 ]; then
  die "--with-web builds the web app from a checkout; a release installs the one it carries"
fi

if ! [[ $listen =~ ^(.+):([0-9]+)$ ]]; then
  die "--listen must be HOST:PORT, got '$listen'"
fi
listen_host=${BASH_REMATCH[1]}
listen_port=${BASH_REMATCH[2]}
# Health checks reach a wildcard address through loopback.
case "$listen_host" in
  0.0.0.0) check_host=127.0.0.1 ;;
  "[::]") check_host="[::1]" ;;
  *) check_host=$listen_host ;;
esac
base_url="http://$check_host:$listen_port"

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [ "$from_release" = 0 ] && ! [ -f "$repo/src-tauri/Cargo.toml" ]; then
  die "run this script from a Toodo checkout ($repo is not one), or pass --release latest"
fi

[ "$(uname -s)" = Linux ] || die "toodo-server is installed on Linux only"

log "Checking prerequisites"
required=(git gh herdr ssh curl)
if [ "$from_release" = 1 ]; then
  [ "$(uname -m)" = x86_64 ] || die "releases carry an x86_64 toodo-server only; build from a checkout instead"
  required+=(tar sha256sum)
else
  required+=(cargo)
fi
[ "$web" = 1 ] && required+=(node npm)
missing=()
for tool in "${required[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ "${#missing[@]}" -gt 0 ]; then
  die "missing on PATH: ${missing[*]}
  cargo: https://rustup.rs   gh: https://cli.github.com   node/npm (--with-web only): https://nodejs.org
  herdr must be installed and running; Toodo never installs it"
fi
if [ "$service" = 1 ]; then
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found; use --no-service to install without a service"
  systemctl --user show-environment >/dev/null 2>&1 \
    || die "no systemd user manager for $USER (systemctl --user failed); log in through a session or use --no-service"
fi

bin_dir=$HOME/.local/bin
share_dir=${XDG_DATA_HOME:-$HOME/.local/share}
web_dir=$share_dir/toodo-server-web
data_dir=$share_dir/toodo-server
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
unit=$unit_dir/toodo-server.service

if [ "$web" = 1 ]; then
  log "Building the web app"
  (cd "$repo" && npm ci && npm run build)
fi

if [ "$from_release" = 1 ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  if [ -n "$from_file" ]; then
    asset=$(basename "$from_file")
    [[ $asset =~ ^toodo-server-(v[0-9]+\.[0-9]+\.[0-9]+)-linux-x86_64\.tar\.gz$ ]] \
      || die "--from-file expects toodo-server-vX.Y.Z-linux-x86_64.tar.gz, got $asset"
    tag=${BASH_REMATCH[1]}
    log "Using $from_file"
    cp "$from_file" "$from_file.sha256" "$work/" || die "need $from_file and $from_file.sha256"
  else
    tag=$release
    if [ "$tag" = latest ]; then
      tag=$(gh release view --repo "$release_repo" --json tagName --jq .tagName) \
        || die "could not look up the latest release of $release_repo (is gh logged in?)"
    fi
    asset=toodo-server-$tag-linux-x86_64.tar.gz
    log "Downloading $asset from $release_repo release $tag"
    gh release download "$tag" --repo "$release_repo" --dir "$work" \
      --pattern "$asset" --pattern "$asset.sha256" \
      || die "could not download $asset from release $tag (releases before the server was published have none)"
  fi
  log "Checking the sha256 of $asset"
  (cd "$work" && sha256sum --check --strict "$asset.sha256") || die "sha256 mismatch for $asset"
  mkdir "$work/unpacked"
  tar -xzf "$work/$asset" -C "$work/unpacked" toodo-server
  new_bin=$work/unpacked/toodo-server
  # Releases from before the web app was published carry the binary only.
  if tar -tzf "$work/$asset" | grep -qx 'web/index.html'; then
    tar -xzf "$work/$asset" -C "$work/unpacked" web
    web=1
    web_src=$work/unpacked/web
  else
    log "$asset carries no web app; serving the API and MCP only"
  fi
  version=$("$new_bin" --version) || die "the downloaded toodo-server does not run on this machine"
  # Builds since 0.12.0 add " (commit <sha>)".
  [ "${version%% (commit *}" = "toodo-server ${tag#v}" ] || die "$asset contains '$version', expected toodo-server ${tag#v}"
else
  log "Building toodo-server"
  (cd "$repo/src-tauri" && cargo build --release --bin toodo-server)
  new_bin=$repo/src-tauri/target/release/toodo-server
  version=$("$new_bin" --version)
  web_src=$repo/dist-web
fi

log "Installing $bin_dir/toodo-server: $version"
mkdir -p "$bin_dir"
tmp_bin=$(mktemp "$bin_dir/.toodo-server.XXXXXX")
cp "$new_bin" "$tmp_bin"
chmod 755 "$tmp_bin"
mv -f "$tmp_bin" "$bin_dir/toodo-server"

if [ "$web" = 1 ]; then
  log "Installing $web_dir"
  mkdir -p "$share_dir"
  tmp_web=$(mktemp -d "$share_dir/.toodo-server-web.XXXXXX")
  cp -R "$web_src/." "$tmp_web/"
  chmod 755 "$tmp_web"
  if [ -e "$web_dir" ]; then
    old_web=$(mktemp -d "$share_dir/.toodo-server-web.old.XXXXXX")
    mv "$web_dir" "$old_web/web"
    mv "$tmp_web" "$web_dir"
    rm -rf "$old_web"
  else
    mv "$tmp_web" "$web_dir"
  fi
fi

if [ "$service" = 0 ]; then
  log "Installed without a service (--no-service). Run it with:"
  if [ "$web" = 1 ]; then
    echo "    TOODO_LISTEN=$listen TOODO_WEB_DIR=$web_dir $bin_dir/toodo-server"
  else
    echo "    TOODO_LISTEN=$listen $bin_dir/toodo-server"
  fi
  exit 0
fi

# The service needs git, ssh, gh, and herdr; take the directories they are found in now.
path_dirs=()
add_path_dir() {
  local dir=$1 seen
  for seen in "${path_dirs[@]+"${path_dirs[@]}"}"; do
    [ "$seen" = "$dir" ] && return 0
  done
  path_dirs+=("$dir")
}
add_path_dir "$bin_dir"
for tool in herdr gh git ssh; do
  add_path_dir "$(dirname "$(command -v "$tool")")"
done
for dir in /usr/local/bin /usr/bin /bin; do
  add_path_dir "$dir"
done
service_path=$(IFS=:; echo "${path_dirs[*]}")
web_env=
[ "$web" = 1 ] && web_env="Environment=TOODO_WEB_DIR=$web_dir"

log "Writing $unit"
mkdir -p "$unit_dir"
tmp_unit=$(mktemp "$unit_dir/.toodo-server.service.XXXXXX")
{
  cat <<EOF
# Written by scripts/install-server.sh; rerun it instead of editing this file.
[Unit]
Description=Toodo server
After=network.target herdr-server.service
Wants=herdr-server.service

[Service]
ExecStart=$bin_dir/toodo-server
Environment=TOODO_LISTEN=$listen
Environment=TOODO_DATA_DIR=$data_dir
EOF
  [ -n "$web_env" ] && echo "$web_env"
  cat <<EOF
Environment=PATH=$service_path
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
} >"$tmp_unit"
chmod 644 "$tmp_unit"
mv -f "$tmp_unit" "$unit"

log "Restarting toodo-server.service"
systemctl --user daemon-reload
systemctl --user enable toodo-server.service >/dev/null
systemctl --user restart toodo-server.service

status_of() { curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$@"; }
api_status() {
  status_of -X POST -H 'Content-Type: application/json' -d '{}' "$base_url/api/rpc/list_tasks"
}

log "Waiting for $base_url"
up=0
for _ in $(seq 1 60); do
  if curl -s -o /dev/null --max-time 2 "$base_url/"; then
    up=1
    break
  fi
  systemctl --user is-active --quiet toodo-server.service || break
  sleep 0.5
done
if [ "$up" = 0 ]; then
  systemctl --user status --no-pager toodo-server.service >&2 || true
  die "toodo-server did not answer on $base_url; see journalctl --user -u toodo-server"
fi

api=$(api_status)
[ "$api" = 401 ] || die "POST $base_url/api/rpc/list_tasks without a token returned $api, expected 401"
if [ "$web" = 1 ]; then
  root=$(status_of "$base_url/")
  [ "$root" = 200 ] || die "GET $base_url/ returned $root, expected 200 (web app)"
  log "Health check passed: /api without a token -> 401, GET / -> 200"
else
  log "Health check passed: /api without a token -> 401"
fi

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != yes ]; then
  echo "note: lingering is off, so the service stops when you log out; run: loginctl enable-linger $USER"
fi

cat <<EOF

$version is running on $base_url
  MCP for agents: $base_url/mcp, token in $data_dir/mcp-token
EOF
if [ "$web" = 1 ]; then
  echo "  Web app: $base_url/, token in $data_dir/web-token"
fi
echo "  Logs: journalctl --user -u toodo-server"
