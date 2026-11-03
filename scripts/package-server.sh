#!/usr/bin/env bash
# Packages a built toodo-server as the release assets the Release workflow uploads:
#   OUT_DIR/toodo-server-v<version>-linux-x86_64.tar.gz          the binary, as ./toodo-server,
#                                                                and the web app, as ./web/
#   OUT_DIR/toodo-server-v<version>-linux-x86_64.tar.gz.sha256   `sha256sum` line for it
# WEB_DIR is the web build (`npm run build` writes dist-web). The version comes from
# `toodo-server --version`. Prints the tarball path.
# scripts/install-server.sh --release installs these assets.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: scripts/package-server.sh BINARY WEB_DIR OUT_DIR" >&2
  exit 2
fi
binary=$1
web_dir=$2
out_dir=$3

[ -x "$binary" ] || { echo "error: $binary is not an executable" >&2; exit 1; }
[ -f "$web_dir/index.html" ] || { echo "error: $web_dir has no index.html; run npm run build" >&2; exit 1; }
[ -f "$web_dir/sw.js" ] || { echo "error: $web_dir is not a web build (no sw.js); run npm run build" >&2; exit 1; }
version_line=$("$binary" --version)
if ! [[ $version_line =~ ^toodo-server\ ([0-9]+\.[0-9]+\.[0-9]+)(\ \(commit\ [0-9a-f]+\))?$ ]]; then
  echo "error: unexpected '$binary --version' output: $version_line" >&2
  exit 1
fi
name=toodo-server-v${BASH_REMATCH[1]}-linux-x86_64

mkdir -p "$out_dir"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
install -m 755 "$binary" "$stage/toodo-server"
mkdir "$stage/web"
cp -R "$web_dir/." "$stage/web/"
chmod -R u=rwX,go=rX "$stage/web"
tar -C "$stage" -czf "$out_dir/$name.tar.gz" --owner=0 --group=0 --numeric-owner toodo-server web
(cd "$out_dir" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
echo "$out_dir/$name.tar.gz"
